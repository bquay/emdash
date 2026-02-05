import { ipcMain } from 'electron';
import JiraService from '../services/JiraService';

const jira = new JiraService();

export function registerJiraIpc() {
  ipcMain.handle(
    'jira:saveCredentials',
    async (_e, args: { siteUrl: string; email: string; token: string }) => {
      const siteUrl = String(args?.siteUrl || '').trim();
      const email = String(args?.email || '').trim();
      const token = String(args?.token || '').trim();
      if (!siteUrl || !email || !token) {
        return { success: false, error: 'Site URL, email, and API token are required.' };
      }
      return jira.saveCredentials(siteUrl, email, token);
    }
  );

  ipcMain.handle('jira:clearCredentials', async () => jira.clearCredentials());
  ipcMain.handle('jira:checkConnection', async () => jira.checkConnection());

  ipcMain.handle(
    'jira:initialFetch',
    async (
      _e,
      limit?: number,
      options?: { hideResolved?: boolean; projectKey?: string; nextPageToken?: string }
    ) => {
      console.log('[jiraIpc] initialFetch called with:', { limit, options });
      try {
        const result = await jira.initialFetch(
          typeof limit === 'number' && Number.isFinite(limit) ? limit : 50,
          options
        );
        return {
          success: true,
          issues: result.issues,
          total: result.total,
          startAt: result.startAt,
          maxResults: result.maxResults,
          nextPageToken: result.nextPageToken,
        };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  );

  ipcMain.handle(
    'jira:searchIssues',
    async (
      _e,
      searchTerm: string,
      limit?: number,
      options?: { hideResolved?: boolean; projectKey?: string; nextPageToken?: string }
    ) => {
      try {
        // Use enhanced search that supports direct key lookups
        const result = await jira.smartSearchIssues(searchTerm, limit ?? 20, options);
        return {
          success: true,
          issues: result.issues,
          total: result.total,
          startAt: result.startAt,
          maxResults: result.maxResults,
          nextPageToken: result.nextPageToken,
        };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  );
}

export default registerJiraIpc;
