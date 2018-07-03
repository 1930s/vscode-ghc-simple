import * as path from 'path';
import * as vscode from 'vscode';
import { DocumentManager } from './document';
import { ExtensionState } from './extension-state';

const regex = {

    // Groups: (Because there's no named group in JS Regex)
    // 1: file
    // 2-3: variant 1: line:col
    // 4-6: variant 2: line:col-col
    // 7-10: variant 3: (line, col)
    message_base: /^(.+):(?:(\d+):(\d+)|(\d+):(\d+)-(\d+)|\((\d+),(\d+)\)-\((\d+),(\d+)\)): (.+)$/,
    single_line_error: /^error: (.+)$/,
    error: /^error:$/,
    warning: /^warning: \[(.+)\]$/
};

interface DiagnosticWithFile {
    file: string;
    diagnostic: vscode.Diagnostic;
}

function parseMessages(messages: string[]):
    DiagnosticWithFile[] {
    const res: DiagnosticWithFile[] = [];

    while (messages.length > 0) {
        const heading = messages.shift();

        if (/^(Ok|Failed),(.*) loaded.$/.test(heading))
            break;

        const res_heading = regex.message_base.exec(heading);
        if (res_heading !== null) {
            const range: vscode.Range = (() => {

            function num(n: number): number { return parseInt(res_heading[n]); }
                if (res_heading[2]) {
                    // line:col
                    const line = num(2);
                    const col = num(3);

                    return new vscode.Range(line - 1, col - 1, line - 1, col - 1);
                } else if (res_heading[4]) {
                    // line:col-col
                    const line = num(4);
                    const col0 = num(5);
                    const col1 = num(6);

                    return new vscode.Range(line - 1, col0 - 1, line - 1, col1);
                } else if (res_heading[7]) {
                    // (line,col)-(line,col)
                    const line0 = num(7);
                    const col0 = num(8);
                    const line1 = num(9);
                    const col1 = num(10);

                    return new vscode.Range(line0 - 1, col0 - 1, line1 - 1, col1);
                } else {
                    // Shouldn't happen!
                    throw 'Strange heading in parseMessages';
                }
            })();

            const res_sl_error = regex.single_line_error.exec(res_heading[11]);
            const res_error = regex.error.exec(res_heading[11]);
            const res_warning = regex.warning.exec(res_heading[11]);

            const sev = vscode.DiagnosticSeverity;

            if (res_sl_error !== null) {
                res.push({
                    file: res_heading[1],
                    diagnostic: new vscode.Diagnostic(range, res_sl_error[1], sev.Error)
                });
            } else {
                const msgs: string[] = [];
                while (messages.length > 0 && messages[0].startsWith('    ')) {
                    msgs.push(messages.shift().substr(4));
                }
                const msg = msgs.join('\n') + (msgs.length ? '\n' : '');

                const severity: vscode.DiagnosticSeverity = (() => {
                    if (res_error !== null) {
                        return sev.Error;
                    } else if (res_warning !== null
                        && ['-Wdeferred-type-errors',
                            '-Wdeferred-out-of-scope-variables',
                            '-Wtyped-holes'
                        ].indexOf(res_warning[1]) >= 0) {
                        return sev.Error;
                    } else if (res_warning !== null) {
                        return sev.Warning;
                    } else {
                        throw 'Strange heading in parseMessages';
                    }
                })();

                res.push({
                    file: res_heading[1],
                    diagnostic: new vscode.Diagnostic(range, msg, severity)
                });
            }
        }
    }

    return res;
}

function stopMgr(document: vscode.TextDocument, ext: ExtensionState) {
    if (ext.docManagers.has(document)) {
        ext.docManagers.get(document).dispose();
        ext.docManagers.delete(document);
    }
}

async function checkHaskell(
    diagnosticCollection: vscode.DiagnosticCollection,
    document: vscode.TextDocument,
    ext: ExtensionState) {
    if (document.languageId == 'haskell' || document.uri.fsPath.endsWith('.hs')) {
        if (! ext.docManagers.has(document)) {
            const dm = new DocumentManager(document.uri.fsPath, ext);
            ext.docManagers.set(document, dm);
        }

        const docMgr: DocumentManager = ext.docManagers.get(document);

        const result = await docMgr.reload();

        const parsed = parseMessages(result);

        const diagMap: Map<vscode.Uri, vscode.Diagnostic[]> = new Map();

        for (const diag of parsed) {
            const uri = vscode.Uri.file(diag.file);
            if (! diagMap.has(uri)) diagMap.set(uri, []);
            diagMap.get(uri).push(diag.diagnostic);
        }

        diagnosticCollection.clear();

        for (const [uri, diags] of diagMap.entries()) {
            diagnosticCollection.set(uri, diags);
        }
    }
}

export function registerDiagnostics(ext: ExtensionState) {
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('ghc-simple');

    const check = (d) => checkHaskell(diagnosticCollection, d, ext);
    const stop = (d) => stopMgr(d, ext);
    const vws = vscode.workspace;

    ext.context.subscriptions.push(
        diagnosticCollection,
        vws.onDidSaveTextDocument(check),
        vws.onDidOpenTextDocument(check),
        vws.onDidCloseTextDocument(stop)
    );
}