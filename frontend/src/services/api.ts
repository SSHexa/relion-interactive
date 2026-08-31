// API Service Layer for RELION Backend
import axios, { AxiosInstance } from 'axios';
import {
  Pipeline,
  PipelineProcess,
  Job,
  JobType,
  ProcessLog,
  Scheme,
  SchemeVariable,
} from '../types/relion';
import { mockJobTemplates } from './mockData';

// Determine the correct API base URL for OOD deployment
function getApiBaseUrl(): string {
  const pathname = window.location.pathname;

  // Check if running under OOD (e.g., /pun/sys/relion5_passenger/)
  const oodMatch = pathname.match(/^(\/pun\/sys\/[^/]+)/);
  if (oodMatch) {
    // Running under OOD - use absolute path with app name
    return `${oodMatch[1]}/api`;
  }

  // Check if running under OOD rnode/node proxy
  const nodeMatch = pathname.match(/^(\/(?:rnode|node)\/[^/]+\/\d+)/);
  if (nodeMatch) {
    return `${nodeMatch[1]}/api`;
  }

  // Default: relative path for local development
  return './api';
}

class RelionAPI {
  private client: AxiosInstance;
  private baseURL: string;

  constructor(baseURL: string = getApiBaseUrl()) {
    this.baseURL = baseURL;
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 30000, // 30 second timeout for large pipelines
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  // Pipeline Management
  async getPipeline(): Promise<Pipeline> {
    const response = await this.client.get('/pipeline');
    return response.data;
  }

  async getProcesses(): Promise<PipelineProcess[]> {
    const response = await this.client.get('/pipeline/processes');
    return response.data;
  }

  async getProcess(processId: string): Promise<PipelineProcess> {
    const response = await this.client.get(`/pipeline/processes/${processId}`);
    return response.data;
  }

  async deleteProcess(processId: string, checkDependencies: boolean = true): Promise<void> {
    await this.client.delete(`/pipeline/processes/${processId}`, {
      params: { checkDependencies },
    });
  }

  async abortProcess(processId: string): Promise<void> {
    await this.client.post(`/pipeline/processes/${processId}/abort`);
  }

  async cleanupProcess(processId: string): Promise<void> {
    await this.client.post(`/pipeline/processes/${processId}/cleanup`);
  }

  // Job Management
  async getJobTypes(): Promise<JobType[]> {
    const response = await this.client.get('/jobs/types');
    return response.data;
  }

  async getJobTemplate(jobType: JobType): Promise<Job> {
    try {
      // Get template from backend
      const response = await this.client.get(`/jobs/template/${jobType}`);
      const backendTemplate = response.data;

      // Get the mock template for UI structure (labels, types, etc.)
      const mockTemplate = mockJobTemplates[jobType];
      if (mockTemplate) {
        // Merge backend params with mock UI structure
        const mergedParams = mockTemplate.parameters.map(param => {
          const backendValue = backendTemplate.params?.[param.variable];
          if (backendValue !== undefined) {
            return { ...param, value: backendValue };
          }
          return param;
        });
        return {
          ...mockTemplate,
          parameters: mergedParams,
        };
      }

      // Fallback: convert backend format to Job format
      return {
        type: jobType,
        name: '',
        alias: '',
        outputDir: '',
        queueSubmit: false,
        nrMpi: 1,
        nrThreads: 1,
        parameters: Object.entries(backendTemplate.params || {}).map(([key, value]) => ({
          label: key,
          variable: key,
          value: value as string | number | boolean,
          type: 'ANY' as const,
          helpText: '',
        })),
      };
    } catch {
      // If backend fails, try to use mock template for UI structure
      const template = mockJobTemplates[jobType];
      if (template) {
        return JSON.parse(JSON.stringify(template));
      }
      throw new Error(`No template for job type: ${jobType}`);
    }
  }

  async getJobOutputs(options?: {
    type?: string;
    status?: string;
    outputType?: string;
  }): Promise<Array<{
    id: string;
    type: string;
    alias?: string;
    status: string;
    outputs: Array<{ type: string; path: string }>;
  }>> {
    const params = new URLSearchParams();
    if (options?.type) params.append('type', options.type);
    if (options?.status) params.append('status', options.status);
    if (options?.outputType) params.append('output_type', options.outputType);

    const response = await this.client.get(`/jobs/outputs?${params.toString()}`);
    return response.data;
  }

  async submitJob(job: Job, mode: 'new' | 'continue' = 'new'): Promise<string> {
    const response = await this.client.post('/jobs/submit', { job, mode });
    return response.data.processId;
  }

  async getJobConfig(processId: string): Promise<Job> {
    const response = await this.client.get(`/jobs/${processId}/config`);
    return response.data;
  }

  async scheduleJob(job: Job): Promise<string> {
    const response = await this.client.post('/jobs/schedule', { job });
    return response.data.processId;
  }

  async runJobAgain(processId: string): Promise<{ processId: string; message: string }> {
    const response = await this.client.post(`/jobs/${processId}/run-again`);
    return response.data;
  }

  // Process Monitoring
  async getProcessLog(processId: string, tail: number = 100): Promise<ProcessLog> {
    const response = await this.client.get(`/pipeline/processes/${processId}/log`, {
      params: { tail },
    });
    return response.data;
  }

  async getProcessStatus(processId: string): Promise<{ status: number; running: boolean }> {
    const response = await this.client.get(`/pipeline/processes/${processId}/status`);
    return response.data;
  }

  // File Browser
  async browseNodes(nodeType?: string): Promise<Array<{name: string; path: string; type: string}>> {
    const response = await this.client.get('/files/nodes', {
      params: { nodeType },
    });
    return response.data;
  }

  async getFileContent(filePath: string): Promise<string> {
    const response = await this.client.get('/files/content', {
      params: { path: filePath },
    });
    return response.data;
  }

  async listDirectory(dirPath: string): Promise<{ name: string; type: 'file' | 'dir' }[]> {
    const response = await this.client.get('/files/list', {
      params: { path: dirPath },
    });
    return response.data;
  }

  // Scheme Management
  async getSchemes(): Promise<string[]> {
    const response = await this.client.get('/schemes');
    return response.data;
  }

  async getScheme(schemeName: string): Promise<Scheme> {
    const response = await this.client.get(`/schemes/${schemeName}`);
    return response.data;
  }

  async startScheme(
    schemeName: string,
    variables?: Record<string, any>
  ): Promise<{ lockId: string }> {
    const response = await this.client.post(`/schemes/${schemeName}/start`, { variables });
    return response.data;
  }

  async abortScheme(schemeName: string): Promise<void> {
    await this.client.post(`/schemes/${schemeName}/abort`);
  }

  async resetScheme(schemeName: string): Promise<void> {
    await this.client.post(`/schemes/${schemeName}/reset`);
  }

  async updateSchemeVariable(
    schemeName: string,
    variableName: string,
    value: any
  ): Promise<void> {
    await this.client.put(`/schemes/${schemeName}/variables/${variableName}`, { value });
  }

  async getSchemeVariables(schemeName: string): Promise<SchemeVariable[]> {
    const response = await this.client.get(`/schemes/${schemeName}/variables`);
    return response.data;
  }

  // STAR File Operations
  async parseStarFile(filePath: string): Promise<any> {
    const response = await this.client.get('/star/parse', {
      params: { path: filePath },
    });
    return response.data;
  }

  async writeStarFile(filePath: string, data: any): Promise<void> {
    await this.client.post('/star/write', { path: filePath, data });
  }

  // Project Management
  async getProjects(): Promise<string[]> {
    const response = await this.client.get('/projects');
    return response.data;
  }

  async openProject(projectPath: string): Promise<Pipeline> {
    const response = await this.client.post('/projects/open', { path: projectPath });
    return response.data;
  }

  async createProject(projectPath: string): Promise<void> {
    await this.client.post('/projects/create', { path: projectPath });
  }

  // WebSocket support was removed — under OOD's reverse proxy the
  // upgrade request never reaches the backend, so callers got a no-op
  // mock. Live updates come from the adaptive polling in Dashboard.tsx.
  // To reintroduce: add a real subscription helper that opens a
  // connection only on non-OOD origins, and gate it behind a feature
  // flag. Don't bring back the silent-no-op pattern.
}

const apiInstance = new RelionAPI();

// Get just the app base path (without /api suffix)
function getAppBasePath(): string {
  const pathname = window.location.pathname;

  // Check if running under OOD (e.g., /pun/sys/relion5_passenger/)
  const oodMatch = pathname.match(/^(\/pun\/sys\/[^/]+)/);
  if (oodMatch) {
    return oodMatch[1];
  }

  // Check if running under OOD rnode/node proxy
  const nodeMatch = pathname.match(/^(\/(?:rnode|node)\/[^/]+\/\d+)/);
  if (nodeMatch) {
    return nodeMatch[1];
  }

  // Default: relative path for local development
  return '.';
}

// Export the base URL getter for components that need direct fetch
export { getApiBaseUrl, getAppBasePath };

export default apiInstance;
