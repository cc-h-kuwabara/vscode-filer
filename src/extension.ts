import * as vscode from 'vscode';
import { FilerController } from './filerController';

let controller: FilerController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  controller = new FilerController(context);
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand('vscode-filer.open', () => {
      void controller?.open();
    })
  );
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}

