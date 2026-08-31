export type JobType3D = 'Refine3D' | 'InitialModel' | 'Class3D' | 'PostProcess';

export interface MRCFileInfo {
  filename: string;
  classNumber?: number;
  resolution?: number;
  particleCount?: number;
  distribution?: number; // Class score percentage
  thumbnailUrl?: string;
}

export interface FSCDataPoint {
  resolution: number;
  fsc: number;
  type?: 'corrected' | 'masked' | 'unmasked';
}

export interface OutputFile {
  name: string;
  path: string;
  size: number;
  type: 'mrc' | 'star' | 'pdf' | 'other';
  description?: string;
}

export interface JobInfo {
  jobId: string;
  jobType: JobType3D;
  iteration?: number;
  voxelSize?: number;
  volumeSize?: [number, number, number];
  finalResolution?: number;
  totalParticles?: number;
  createdAt?: string;
  completedAt?: string;
}

export interface Results3DSummary {
  jobType: JobType3D;
  jobInfo: JobInfo;
  mrcFiles: MRCFileInfo[];
  fscData: FSCDataPoint[];
  outputFiles: OutputFile[];
}
