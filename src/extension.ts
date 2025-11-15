import * as vscode from 'vscode';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { ConfigManager } from './services/ConfigManager';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const configManager = new ConfigManager();
  await configManager.init();

  const sidebarProvider = new SidebarProvider(context, configManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebarProvider),
  );
}

export function deactivate() {}
