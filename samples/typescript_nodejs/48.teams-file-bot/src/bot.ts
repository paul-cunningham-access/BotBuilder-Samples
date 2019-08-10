// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { InvokeResponse, TurnContext } from 'botbuilder';
import {
    FileConsentCardResponse,
    FileDownloadInfo,
    InvokeRequestActivity,
    TeamsActivityHandler,
    TeamsAttachment,
    TeamsFactory
} from 'botbuilder-teams';
import * as fs from 'fs';
import * as path from 'path';
import * as request from 'request';

/**
 * Define data type for accept context
 */
interface ConsentContext {
    filename: string;
}

export class FileBot extends TeamsActivityHandler {
    private readonly fileFolder = './files';

    constructor () {
        super();
        this.onMessage(this.routeMessageActivities.bind(this));
        this.onFileConsent(async (context, next): Promise<InvokeResponse> => {
            // InvokeActivityHandlers need to send a response to Teams.
            // In this scenario, the helper method `FileBot.handleFileConsent` returns an InvokeResponse which will be sent
            // to Teams. We store this response and return it after running any additional InvokeActivityHandlers
            const invokeResponse: InvokeResponse = await this.handleFileConsent.bind(this)(context, (context.activity as InvokeRequestActivity<FileConsentCardResponse>).value);
            
            // By calling next() you ensure that the next InvokeActivityHandler is run.
            await next();
            return invokeResponse;
        });
    }

    private async routeMessageActivities(context, next): Promise<void> {
        const attachments = context.activity.attachments || [];
        // Needs investigation on whether or not multiple attachments are sent in one activity or not.
        // If multiple attachments are sent in an activity, then the rest of the attachments will be dropped on the floor.
        const fileDownload: TeamsAttachment<FileDownloadInfo> = attachments.map(x => TeamsFactory.isFileDownloadInfoAttachment(x) && x).shift();
        if (fileDownload) {
            await this.onMessageWithFileDownloadInfo(context, fileDownload.content);
        } else {
            const filename = 'teams-logo.png';
            const fileinfo = fs.statSync(path.join(this.fileFolder, filename));
            await this.sendFileCard(context, filename, fileinfo.size);
        }
        
        // By calling next() you ensure that the next BotHandler is run.
        await next();
    }

    private async handleFileConsent(context: TurnContext, query: FileConsentCardResponse): Promise<InvokeResponse> {
        await context.sendActivity({ textFormat: 'xml', text: `<b>Received user's consent</b> <pre>${JSON.stringify(query, null, 2)}</pre>`});

        const queryContext: ConsentContext = query.context;

        // 'Accepted' case
        if (query.action === 'accept') {
            const fname = `${this.fileFolder}/${queryContext.filename}`;
            const fileInfo = fs.statSync(fname);
            const file = Buffer.from(fs.readFileSync(fname, 'binary'), 'binary');
            await context.sendActivity({ textFormat: 'xml', text: `Uploading <b>${queryContext.filename}</b>`});
            const r = new Promise((resolve, reject) => {
                request.put({
                    uri: query.uploadInfo.uploadUrl,
                    headers: {
                        'Content-Length': fileInfo.size,
                        'Content-Range': `bytes 0-${fileInfo.size-1}/${fileInfo.size}`
                    },
                    encoding: null,
                    body: file
                }, async (err, res) => {
                    if (err) {
                        reject(err);
                    } else {
                        const data = Buffer.from(res.body, 'binary').toString('utf8');
                        resolve(JSON.parse(data));
                    }
                });
            });

            return r.then(async res => {
                await this.fileUploadCompleted(context, query, res);
                return { status: 200 }
            }).catch(async err => {
                await this.fileUploadFailed(context, err);
                return { status: 500, body: `File upload failed: ${JSON.stringify(err)}` }
            });
        }

        // 'Declined' case
        if (query.action === 'decline') {
            await context.sendActivity({ textFormat: 'xml', text: `Declined. We won't upload file <b>${queryContext.filename}</b>.`} );
        }

        return { status: 200 };
    }

    private async onMessageWithFileDownloadInfo(context, file): Promise<void> {
        await context.sendActivity({ textFormat: 'xml', text: `<b>Received File</b> <pre>${JSON.stringify(file, null, 2)}</pre>`});
        let filename: string;
        // Rewrite this logic.
        const err = await new Promise((resolve, reject) => {
            let r = request(file.downloadUrl);
            r.on('response', (res) => {
                const regexp = /filename=\"(.*)\"/gi;
                filename = regexp.exec(res.headers['content-disposition'])[1];
                res.pipe(fs.createWriteStream(`${this.fileFolder}/${filename}`));
            });
            r.on('error', (err) => resolve(err));
            r.on('complete', (res) => resolve());
        });
        if (!err && !!filename) {
            await context.sendActivity({ textFormat: 'xml', text: `Complete downloading <b>${filename}</b>` });
        }
    }

    private async sendFileCard (ctx: TurnContext, filename: string, filesize: number) {
        const fileCard = TeamsFactory.fileConsentCard(
            filename,
            {
                'description': 'This is the file I want to send you',
                'sizeInBytes': filesize,
                'acceptContext': <ConsentContext> {
                    filename
                },
                'declineContext': <ConsentContext> {
                    filename
                }
            }
        );
        await ctx.sendActivities([ { attachments: [fileCard] } ]);
    }

    private async fileUploadCompleted (ctx: TurnContext, query: FileConsentCardResponse, response: any) {
        const downloadCard = TeamsFactory.fileInfoCard(
            query.uploadInfo.name,
            query.uploadInfo.contentUrl,
            {
                'uniqueId': query.uploadInfo.uniqueId,
                'fileType': query.uploadInfo.fileType
            }
        );
        await ctx.sendActivities([
            {
                textFormat: 'xml', 
                text: `<b>File Upload Completed</b> <pre>${JSON.stringify(response, null, 2)}</pre>`
            },
            { 
                textFormat: 'xml',
                text: `Your file <b>${query.context.filename}</b> is ready to download`,
                attachments: [downloadCard] 
            }
        ]);
    }

    private async fileUploadFailed (ctx: TurnContext, error: any) {
        await ctx.sendActivity({
            textFormat: 'xml', 
            text: `<b>File Upload Failed</b> <pre>${JSON.stringify(error, null, 2)}</pre>`
        });
    }
}
