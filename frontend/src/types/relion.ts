// RELION 5 Type Definitions

export enum ProcessStatus {
  SCHEDULED = 0,
  RUNNING = 1,
  FINISHED_SUCCESS = 2,
  FINISHED_ABORTED = 3,
  FINISHED_FAILURE = 4,
}

export enum JobType {
  IMPORT = 'Import',
  MOTIONCORR = 'MotionCorr',
  CTFFIND = 'CtfFind',
  MANUALPICK = 'ManualPick',
  AUTOPICK = 'AutoPick',
  EXTRACT = 'Extract',
  CLASS2D = 'Class2D',
  CLASS3D = 'Class3D',
  REFINE3D = 'Refine3D',
  MULTIBODY = 'MultiBody',
  CTFREFINE = 'CtfRefine',
  MOTIONREFINE = 'MotionRefine',
  POSTPROCESS = 'PostProcess',
  LOCRES = 'LocalRes',
  MASKCREATE = 'MaskCreate',
  JOINSTAR = 'JoinStar',
  SUBTRACT = 'Subtract',
  INIMODEL = 'InitialModel',
  CLASSSELECT = 'ClassSelect',
  CLASSRANKER = 'ClassRanker',
  MODELANGELO = 'ModelAngelo',
  DYNAMIGHT = 'DynaMight',
  EXTERNAL = 'External',
  // Tomography jobs (50-59)
  TOMO_IMPORT = 'TomoImport',
  TOMO_EXCLUDETILTS = 'TomoExcludeTilts',
  TOMO_ALIGNTILTS = 'TomoAlignTilts',
  TOMO_RECONSTRUCT = 'TomoReconstruct',
  TOMO_DENOISE = 'TomoDenoise',
  TOMO_IMPORTPARTICLES = 'TomoImportParticles',
  TOMO_SUBTOMO = 'TomoSubtomo',
  TOMO_CTFREFINE = 'TomoCtfRefine',
}

export interface PipelineNode {
  name: string;
  type: string;
  alias?: string;
}

export interface PipelineProcess {
  id: string;
  name: string;
  alias: string;
  type: JobType;
  status: ProcessStatus;
  inputNodes: string[];
  outputNodes: string[];
}

export interface JobParameter {
  label: string;
  variable: string;
  value: string | number | boolean;
  type: 'ANY' | 'FILENAME' | 'INPUTNODE' | 'RADIO' | 'BOOLEAN' | 'SLIDER' | 'ONLYTEXT' | 'DIRECTORY';
  helpText?: string;
  minValue?: number;
  maxValue?: number;
  stepValue?: number;
  pattern?: string;
  nodeType?: string;
  options?: string[];
  optional?: boolean;
}

export interface Job {
  type: JobType;
  name: string;
  alias: string;
  outputDir: string;
  parameters: JobParameter[];
  queueSubmit: boolean;
  queueName?: string;
  nrMpi?: number;
  nrThreads?: number;
}

export interface SchemeVariable {
  name: string;
  type: 'float' | 'boolean' | 'string';
  originalValue: string | number | boolean;
  currentValue: string | number | boolean;
}

export interface SchemeOperator {
  type: string;
  input1?: string;
  input2?: string;
  output?: string;
}

export interface SchemeJob {
  name: string;
  mode: 'new' | 'continue';
  alias: string;
  executed: boolean;
}

export interface SchemeEdge {
  from: string;
  to: string;
  condition?: string;
  label?: string;
}

export interface Scheme {
  name: string;
  variables: SchemeVariable[];
  operators: SchemeOperator[];
  jobs: SchemeJob[];
  edges: SchemeEdge[];
  currentNode?: string;
}

export interface ProcessLog {
  jobName: string;
  stdout: string[];
  stderr: string[];
  lastUpdate: Date;
}

export interface Pipeline {
  processes: PipelineProcess[];
  nodes: PipelineNode[];
  name: string;
  projectDir: string;
  lastModified: Date;
}
