import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  TextField,
  FormControl,
  Checkbox,
  FormControlLabel,
  Slider,
  Typography,
  Button,
  Paper,
  Divider,
  Radio,
  RadioGroup,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Select,
  MenuItem,
  InputLabel,
  Alert,
  CircularProgress,
  FormHelperText,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import {
  ExpandMore,
  HelpOutline,
  FolderOpen,
  PlayArrow,
  Schedule,
  Link as LinkIcon,
  CloudUpload,
} from '@mui/icons-material';
import { Job, JobParameter } from '../types/relion';
import FileBrowser from './FileBrowser';
import UploadDialog from './UploadDialog';
import api, { getAppBasePath } from '../services/api';

// Map nodeType to job types that produce compatible outputs
const nodeTypeToJobTypes: Record<string, string[]> = {
  'MicrographsData.star': ['CtfFind', 'MotionCorr', 'Import'],
  'CtfFind/job': ['CtfFind'],
  'AutoPick/job': ['AutoPick'],
  'ManualPick/job': ['ManualPick'],
  'Extract/job': ['Extract'],
  'Class2D/job': ['Class2D'],
  'Class3D/job': ['Class3D'],
  'Refine3D/job': ['Refine3D'],
  'particles': ['Extract', 'Class2D', 'Class3D', 'Refine3D', 'CtfRefine', 'Polish'],
  'coords': ['AutoPick', 'ManualPick'],
  'micrographs': ['CtfFind', 'MotionCorr', 'Import'],
};

interface JobOutput {
  id: string;
  type: string;
  alias?: string;
  status: string;
  outputs: Array<{ type: string; path: string }>;
}

interface JobConfigFormProps {
  job: Job;
  onSubmit: (job: Job, mode: 'new' | 'continue') => void;
  onSchedule?: (job: Job) => void;
  readOnly?: boolean;
  projectDir?: string;  // Current project directory
}

// Default project directory fallback
// Last-resort fallback when the backend's /api/config/defaults call fails.
// On a healthy deploy this constant is never read — the projectDir prop is
// supplied from the parent (Dashboard) and the runtime default comes from
// the backend's project_base_dir.
const DEFAULT_PROJECT_DIR_FALLBACK = '${HOME}/relion_projects';

const JobConfigForm: React.FC<JobConfigFormProps> = ({
  job: initialJob,
  onSubmit,
  onSchedule,
  readOnly = false,
  projectDir,
}) => {
  // When the parent doesn't supply projectDir (e.g. user opens "New Job"
  // before selecting a project), fetch the server's project_base_dir
  // instead of trusting a baked-in constant.
  const [serverDefaultDir, setServerDefaultDir] = useState<string>(DEFAULT_PROJECT_DIR_FALLBACK);
  useEffect(() => {
    let aborted = false;
    fetch(`${getAppBasePath()}/api/config/defaults`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!aborted && data?.defaultProjectDir) {
          setServerDefaultDir(data.defaultProjectDir);
        }
      })
      .catch(() => {/* keep the fallback constant */});
    return () => { aborted = true; };
  }, []);
  const effectiveProjectDir = projectDir || serverDefaultDir;
  const [job, setJob] = useState<Job>(initialJob);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [fileBrowserTarget, setFileBrowserTarget] = useState<string | null>(null);
  const [fileBrowserForJobProperty, setFileBrowserForJobProperty] = useState<string | null>(null);
  const [fileBrowserKey, setFileBrowserKey] = useState(0);
  const [fileBrowserSelectDirectory, setFileBrowserSelectDirectory] = useState(false);
  const [fileBrowserAllowPattern, setFileBrowserAllowPattern] = useState(false);
  const [fileBrowserMultiSelect, setFileBrowserMultiSelect] = useState(false);
  const [fileBrowserFileFilter, setFileBrowserFileFilter] = useState('');
  const [fileBrowserNodeType, setFileBrowserNodeType] = useState<string | undefined>(undefined);
  const [availableJobs, setAvailableJobs] = useState<Record<string, JobOutput[]>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  // Local-file upload (Upload button next to Browse on FILENAME fields).
  // Holds the parameter `variable` we're uploading for, or null when closed.
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const [loadingJobs, setLoadingJobs] = useState(false);

  useEffect(() => {
    setJob(initialJob);
  }, [initialJob]);

  // Fetch available jobs for INPUTNODE fields
  useEffect(() => {
    const fetchJobOutputs = async () => {
      setLoadingJobs(true);
      // Get unique nodeTypes from INPUTNODE parameters
      const nodeTypes = new Set<string>();
      initialJob.parameters?.forEach(param => {
        if (param.type === 'INPUTNODE' && param.nodeType) {
          nodeTypes.add(param.nodeType);
        }
      });

      // Fetch jobs for each nodeType
      const jobsByNodeType: Record<string, JobOutput[]> = {};
      for (const nodeType of Array.from(nodeTypes)) {
        const jobTypes = nodeTypeToJobTypes[nodeType] || [];
        const allJobs: JobOutput[] = [];

        for (const jobType of jobTypes) {
          try {
            const jobs = await api.getJobOutputs({ type: jobType, status: 'Finished' });
            allJobs.push(...jobs);
          } catch (error) {
            console.error(`Failed to fetch jobs for type ${jobType}:`, error);
          }
        }

        // Deduplicate by job id
        const uniqueJobs = allJobs.filter((job, index, self) =>
          index === self.findIndex(j => j.id === job.id)
        );
        jobsByNodeType[nodeType] = uniqueJobs;
      }

      setAvailableJobs(jobsByNodeType);
      setLoadingJobs(false);
    };

    if (initialJob.parameters?.some(p => p.type === 'INPUTNODE')) {
      fetchJobOutputs();
    }
  }, [initialJob]);

  const openFileBrowser = (
    variable: string,
    isJobProperty: boolean = false,
    selectDirectory: boolean = false,
    allowPattern: boolean = false,
    multiSelect: boolean = false,
    fileFilter: string = '',
    nodeType?: string
  ) => {
    if (isJobProperty) {
      setFileBrowserForJobProperty(variable);
      setFileBrowserTarget(null);
    } else {
      setFileBrowserTarget(variable);
      setFileBrowserForJobProperty(null);
    }
    setFileBrowserSelectDirectory(selectDirectory);
    setFileBrowserAllowPattern(allowPattern);
    setFileBrowserMultiSelect(multiSelect);
    setFileBrowserFileFilter(fileFilter);
    setFileBrowserNodeType(nodeType);
    // Increment key to force FileBrowser to remount and reset to rootPath
    setFileBrowserKey(prev => prev + 1);
    setFileBrowserOpen(true);
  };

  const handleFileSelect = (filePath: string) => {
    if (fileBrowserForJobProperty) {
      handleJobPropertyChange(fileBrowserForJobProperty as keyof Job, filePath);
    } else if (fileBrowserTarget) {
      handleParameterChange(fileBrowserTarget, filePath);
    }
    setFileBrowserOpen(false);
    setFileBrowserTarget(null);
    setFileBrowserForJobProperty(null);
  };

  const handleMultiFileSelect = (filePaths: string[]) => {
    if (fileBrowserTarget) {
      // Join multiple files with wildcard pattern based on common directory
      if (filePaths.length > 0) {
        // Find common directory
        const firstPath = filePaths[0];
        const dirPath = firstPath.substring(0, firstPath.lastIndexOf('/'));
        // Get file extension from first file
        const ext = firstPath.substring(firstPath.lastIndexOf('.'));
        // Create pattern like "Movies/*.tiff"
        const pattern = `${dirPath}/*${ext}`;
        handleParameterChange(fileBrowserTarget, pattern);
      }
    }
    setFileBrowserOpen(false);
    setFileBrowserTarget(null);
    setFileBrowserForJobProperty(null);
  };

  const handleParameterChange = (variable: string, value: any) => {
    setJob((prev) => ({
      ...prev,
      parameters: prev.parameters.map((param) =>
        param.variable === variable ? { ...param, value } : param
      ),
    }));

    // Clear error for this field
    if (errors.has(variable)) {
      const newErrors = new Map(errors);
      newErrors.delete(variable);
      setErrors(newErrors);
    }
  };

  const handleJobPropertyChange = (property: keyof Job, value: any) => {
    setJob((prev) => ({ ...prev, [property]: value }));
  };

  // Validation rules — single source of truth for both blur and submit.
  // Previously these lists were only consulted by validateForm(), so a field
  // in OPTIONAL_PARAMS would still show "X is required" on blur. Now both
  // paths run validateParameter() and stay aligned automatically.

  // Frontend doesn't enforce these on the backend — they tune which fields
  // can be left blank in the form without producing a user-facing error.
  const OPTIONAL_PARAM_NAMES = new Set<string>([
    'fn_gain_ref',   // Gain reference (motion correction)
    'fn_defect',     // Defect file
    'fn_mask',       // Mask files are often optional
    'fn_mtf',        // MTF file
    'beamtilt_x',    // Beam tilt
    'beamtilt_y',
    'fn_refs',       // 2D references for autopick (optional for LoG)
    'select_label',  // ClassSelect - class identifier (optional)
    'select_minval', // ClassSelect - min value (optional)
    'select_maxval', // ClassSelect - max value (optional)
  ]);

  // For these job types, exactly one of the listed fields must have a value.
  const MUTUALLY_EXCLUSIVE_GROUPS: { [jobType: string]: string[][] } = {
    'ClassSelect': [['fn_data', 'fn_mic']],
  };

  /** Returns an error message for `param`, or null if valid. */
  const validateParameter = useCallback(
    (
      param: JobParameter,
      satisfiedExclusiveFields: Set<string>,
      exclusiveGroupsForType: string[][],
    ): string | null => {
      // Mutually-exclusive group is already satisfied by another sibling.
      if (satisfiedExclusiveFields.has(param.variable)) return null;

      // Required-field check.
      const isEmpty = param.value === '' || param.value === null || param.value === undefined;
      if (
        param.type !== 'BOOLEAN' &&
        param.type !== 'ONLYTEXT' &&
        !OPTIONAL_PARAM_NAMES.has(param.variable) &&
        !param.optional &&
        isEmpty
      ) {
        const groupIndex = exclusiveGroupsForType.findIndex((g) => g.includes(param.variable));
        return groupIndex !== -1
          ? 'Fill in one of the OR options above'
          : `${param.label || param.variable} is required`;
      }

      // FILENAME pattern check.
      if (param.type === 'FILENAME' && param.value) {
        const value = String(param.value);
        if (param.pattern && !new RegExp(param.pattern).test(value)) {
          return `Must match pattern: ${param.pattern}`;
        }
      }

      // SLIDER range check.
      if (param.type === 'SLIDER') {
        const numValue = Number(param.value);
        if (param.minValue !== undefined && numValue < param.minValue) {
          return `Must be at least ${param.minValue}`;
        }
        if (param.maxValue !== undefined && numValue > param.maxValue) {
          return `Must be at most ${param.maxValue}`;
        }
      }

      return null;
    },
    [],
  );

  /** Compute which fields participate in a satisfied mutex group. */
  const computeSatisfiedExclusiveFields = useCallback(
    (params: JobParameter[], exclusiveGroups: string[][]): Set<string> => {
      const satisfied = new Set<string>();
      exclusiveGroups.forEach((group) => {
        const someHasValue = group.some((variable) => {
          const p = params.find((q) => q.variable === variable);
          return p && p.value !== '' && p.value !== null && p.value !== undefined;
        });
        if (someHasValue) {
          group.forEach((f) => satisfied.add(f));
        }
      });
      return satisfied;
    },
    [],
  );

  const handleFieldBlur = (variable: string, _value: string, param: JobParameter) => {
    const exclusiveGroups = MUTUALLY_EXCLUSIVE_GROUPS[job.type] || [];
    // Use the *current* job state for blur — keeps mutex-group logic correct
    // even when the user fills the partner field first.
    const satisfied = computeSatisfiedExclusiveFields(job.parameters, exclusiveGroups);
    const err = validateParameter(param, satisfied, exclusiveGroups);
    setErrors((prev) => {
      const m = new Map(prev);
      if (err) m.set(variable, err);
      else m.delete(variable);
      return m;
    });
  };

  const validateForm = (): boolean => {
    const exclusiveGroups = MUTUALLY_EXCLUSIVE_GROUPS[job.type] || [];
    const satisfied = computeSatisfiedExclusiveFields(job.parameters, exclusiveGroups);
    const newErrors = new Map<string, string>();
    job.parameters.forEach((param) => {
      const err = validateParameter(param, satisfied, exclusiveGroups);
      if (err) newErrors.set(param.variable, err);
    });
    setErrors(newErrors);
    return newErrors.size === 0;
  };

  const handleSubmit = (mode: 'new' | 'continue') => {
    setSubmitAttempted(true);
    if (validateForm()) {
      onSubmit(job, mode);
    }
  };

  const handleScheduleClick = () => {
    setSubmitAttempted(true);
    if (validateForm() && onSchedule) {
      onSchedule(job);
    }
  };

  const renderParameter = (param: JobParameter) => {
    const error = errors.get(param.variable);

    switch (param.type) {
      case 'BOOLEAN':
        return (
          <Box>
            <FormControlLabel
              control={
                <Checkbox
                  checked={Boolean(param.value)}
                  onChange={(e) => handleParameterChange(param.variable, e.target.checked)}
                  disabled={readOnly}
                />
              }
              label={
                <Box display="flex" alignItems="center">
                  <Typography>{param.label}</Typography>
                  {param.helpText && (
                    <Tooltip title={param.helpText}>
                      <HelpOutline fontSize="small" sx={{ ml: 1, color: 'action.active' }} />
                    </Tooltip>
                  )}
                </Box>
              }
            />
            {error && (
              <FormHelperText error>{error}</FormHelperText>
            )}
          </Box>
        );

      case 'SLIDER':
        return (
          <Box>
            <Box display="flex" alignItems="center" mb={1}>
              <Typography variant="body2">{param.label}</Typography>
              {param.helpText && (
                <Tooltip title={param.helpText}>
                  <HelpOutline fontSize="small" sx={{ ml: 1, color: 'action.active' }} />
                </Tooltip>
              )}
            </Box>
            <Slider
              value={Number(param.value) || 0}
              onChange={(_e, value) => handleParameterChange(param.variable, value)}
              min={param.minValue || 0}
              max={param.maxValue || 100}
              step={param.stepValue || 1}
              valueLabelDisplay="auto"
              disabled={readOnly}
              marks
            />
            <Typography variant="caption" color="text.secondary">
              Current: {param.value}
            </Typography>
            {error && (
              <FormHelperText error>{error}</FormHelperText>
            )}
          </Box>
        );

      case 'RADIO':
        return (
          <FormControl component="fieldset" error={!!error}>
            <Box display="flex" alignItems="center" mb={1}>
              <Typography variant="body2">{param.label}</Typography>
              {param.helpText && (
                <Tooltip title={param.helpText}>
                  <HelpOutline fontSize="small" sx={{ ml: 1, color: 'action.active' }} />
                </Tooltip>
              )}
            </Box>
            <RadioGroup
              value={param.value}
              onChange={(e) => handleParameterChange(param.variable, e.target.value)}
            >
              {param.options?.map((option) => (
                <FormControlLabel
                  key={option}
                  value={option}
                  control={<Radio />}
                  label={option}
                  disabled={readOnly}
                />
              ))}
            </RadioGroup>
            {error && (
              <Typography variant="caption" color="error">
                {error}
              </Typography>
            )}
          </FormControl>
        );

      case 'DIRECTORY':
        return (
          <TextField
            fullWidth
            label={param.label}
            value={param.value}
            onChange={(e) => handleParameterChange(param.variable, e.target.value)}
            onBlur={(e) => handleFieldBlur(param.variable, e.target.value, param)}
            error={!!error}
            helperText={error || param.helpText}
            disabled={readOnly}
            slotProps={{
              htmlInput: { maxLength: 4096 },
              input: {
                endAdornment: (
                  <Button
                    size="small"
                    startIcon={<FolderOpen />}
                    disabled={readOnly}
                    onClick={() => openFileBrowser(param.variable, false, true)}
                  >
                    Browse Folder
                  </Button>
                ),
              },
            }}
          />
        );

      case 'FILENAME':
        // Enable pattern/multi-select support for raw movie/image file inputs
        const isRawMovieInput = param.variable === 'fn_in_raw';
        return (
          <TextField
            fullWidth
            label={param.label}
            value={param.value}
            onChange={(e) => handleParameterChange(param.variable, e.target.value)}
            onBlur={(e) => handleFieldBlur(param.variable, e.target.value, param)}
            error={!!error}
            helperText={error || param.helpText || (isRawMovieInput ? 'Use patterns like Movies/*.tiff or click Browse to select multiple files' : '')}
            disabled={readOnly}
            slotProps={{
              htmlInput: { maxLength: 4096 },
              input: {
                endAdornment: (
                  <Box display="flex" gap={1}>
                    <Button
                      size="small"
                      startIcon={<FolderOpen />}
                      disabled={readOnly}
                      onClick={() => openFileBrowser(param.variable, false, false, true, isRawMovieInput, '', param.nodeType)}
                    >
                      Browse
                    </Button>
                    <Button
                      size="small"
                      startIcon={<CloudUpload />}
                      disabled={readOnly}
                      onClick={() => setUploadFor(param.variable)}
                    >
                      Upload
                    </Button>
                  </Box>
                ),
              },
            }}
          />
        );

      case 'INPUTNODE':
        // INPUTNODE fields can select from available jobs or browse for files
        const nodeTypeJobs = param.nodeType ? availableJobs[param.nodeType] || [] : [];
        const hasAvailableJobs = nodeTypeJobs.length > 0;

        return (
          <Box>
            <TextField
              fullWidth
              label={param.label}
              value={param.value}
              onChange={(e) => handleParameterChange(param.variable, e.target.value)}
              onBlur={(e) => handleFieldBlur(param.variable, e.target.value, param)}
              error={!!error}
              helperText={error || param.helpText}
              disabled={readOnly}
              slotProps={{
                htmlInput: { maxLength: 4096 },
                input: {
                  endAdornment: (
                    <Box display="flex" gap={1}>
                      <Button
                        size="small"
                        startIcon={<FolderOpen />}
                        disabled={readOnly}
                        onClick={() => openFileBrowser(param.variable, false, false, true, false, '', param.nodeType)}
                      >
                        Browse
                      </Button>
                    </Box>
                  ),
                },
              }}
            />
            {loadingJobs && (
              <Box display="flex" alignItems="center" gap={1} sx={{ mt: 1 }}>
                <CircularProgress size={16} />
                <Typography variant="caption">Loading jobs...</Typography>
              </Box>
            )}
            {!loadingJobs && hasAvailableJobs && (
              <FormControl fullWidth size="small" sx={{ mt: 1 }}>
                <InputLabel>Select from completed jobs</InputLabel>
                <Select
                  value=""
                  label="Select from completed jobs"
                  disabled={readOnly}
                  onChange={(e) => {
                    const selectedPath = e.target.value;
                    if (selectedPath) {
                      handleParameterChange(param.variable, selectedPath);
                    }
                  }}
                  startAdornment={<LinkIcon sx={{ mr: 1, color: 'action.active' }} />}
                >
                  {nodeTypeJobs.map((job) => {
                    const primaryOutput = job.outputs[0];
                    const displayPath = primaryOutput?.path || job.id;
                    return (
                      <MenuItem key={job.id} value={displayPath}>
                        <Box>
                          <Typography variant="body2">
                            {job.id} {job.alias && `(${job.alias})`}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {primaryOutput?.path || 'No output file'}
                          </Typography>
                        </Box>
                      </MenuItem>
                    );
                  })}
                </Select>
              </FormControl>
            )}
          </Box>
        );

      case 'ONLYTEXT':
        return (
          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
              {param.label}
            </Typography>
            {param.helpText && (
              <Typography variant="caption" color="text.secondary">
                {param.helpText}
              </Typography>
            )}
            {error && (
              <FormHelperText error>{error}</FormHelperText>
            )}
          </Box>
        );

      case 'ANY':
      default:
        return (
          <TextField
            fullWidth
            label={param.label}
            value={param.value}
            onChange={(e) => handleParameterChange(param.variable, e.target.value)}
            onBlur={(e) => handleFieldBlur(param.variable, e.target.value, param)}
            error={!!error}
            helperText={error || param.helpText}
            disabled={readOnly}
            slotProps={{ htmlInput: { maxLength: 1024 } }}
          />
        );
    }
  };

  // Group parameters by category (you can enhance this)
  const renderParameters = () => {
    if (!job.parameters || !Array.isArray(job.parameters)) {
      return (
        <Typography variant="body2" color="text.secondary">
          No parameters available for this job type.
        </Typography>
      );
    }
    return (
      <Grid container spacing={2}>
        {job.parameters.map((param) => (
          <Grid size={{ xs: 12 }} key={param.variable}>
            {renderParameter(param)}
          </Grid>
        ))}
      </Grid>
    );
  };

  return (
    <Paper elevation={2} sx={{ p: 3 }}>
      <Typography variant="h6" gutterBottom>
        {job.type} Configuration
      </Typography>
      <Typography variant="body2" color="text.secondary" gutterBottom>
        {job.alias || job.name}
      </Typography>

      <Divider sx={{ my: 2 }} />

      {submitAttempted && errors.size > 0 && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {errors.size} field{errors.size > 1 ? 's' : ''} need{errors.size === 1 ? 's' : ''} attention before submitting.
        </Alert>
      )}

      {/* Basic Job Settings */}
      <Accordion defaultExpanded>
        <AccordionSummary expandIcon={<ExpandMore />}>
          <Typography variant="subtitle1">Basic Settings</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12 }}>
              <TextField
                fullWidth
                label="Job Alias"
                value={job.alias}
                onChange={(e) => handleJobPropertyChange('alias', e.target.value)}
                disabled={readOnly}
                helperText="Friendly name for this job"
                slotProps={{ htmlInput: { maxLength: 128 } }}
              />
            </Grid>
            <Grid size={{ xs: 12 }}>
              <TextField
                fullWidth
                label="Output Directory"
                value={job.outputDir}
                onChange={(e) => handleJobPropertyChange('outputDir', e.target.value)}
                disabled={readOnly}
                slotProps={{
                  htmlInput: { maxLength: 4096 },
                  input: {
                    endAdornment: (
                      <Button
                        size="small"
                        startIcon={<FolderOpen />}
                        disabled={readOnly}
                        onClick={() => openFileBrowser('outputDir', true)}
                      >
                        Browse
                      </Button>
                    ),
                  },
                }}
              />
            </Grid>
          </Grid>
        </AccordionDetails>
      </Accordion>

      {/* Job Parameters */}
      <Accordion defaultExpanded>
        <AccordionSummary expandIcon={<ExpandMore />}>
          <Typography variant="subtitle1">Parameters</Typography>
        </AccordionSummary>
        <AccordionDetails>{renderParameters()}</AccordionDetails>
      </Accordion>

      {/* Compute Settings */}
      <Accordion>
        <AccordionSummary expandIcon={<ExpandMore />}>
          <Typography variant="subtitle1">Compute Settings</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12 }}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={job.queueSubmit}
                    onChange={(e) => handleJobPropertyChange('queueSubmit', e.target.checked)}
                    disabled={readOnly}
                  />
                }
                label="Submit to queue system"
              />
            </Grid>
            {job.queueSubmit && (
              <Grid size={{ xs: 12 }}>
                <TextField
                  fullWidth
                  label="Queue Name"
                  value={job.queueName || ''}
                  onChange={(e) => handleJobPropertyChange('queueName', e.target.value)}
                  disabled={readOnly}
                  slotProps={{ htmlInput: { maxLength: 64 } }}
                />
              </Grid>
            )}
            <Grid size={{ xs: 6 }}>
              <TextField
                fullWidth
                type="number"
                label="Number of MPI processes"
                value={job.nrMpi || 1}
                onChange={(e) => handleJobPropertyChange('nrMpi', parseInt(e.target.value))}
                disabled={readOnly}
              />
            </Grid>
            <Grid size={{ xs: 6 }}>
              <TextField
                fullWidth
                type="number"
                label="Number of threads"
                value={job.nrThreads || 1}
                onChange={(e) => handleJobPropertyChange('nrThreads', parseInt(e.target.value))}
                disabled={readOnly}
              />
            </Grid>
          </Grid>
        </AccordionDetails>
      </Accordion>

      {/* Action Buttons */}
      {!readOnly && (
        <Box mt={3} display="flex" gap={2}>
          <Button
            variant="contained"
            color="primary"
            startIcon={<PlayArrow />}
            onClick={() => handleSubmit('new')}
            fullWidth
          >
            Run Job
          </Button>
          <Button
            variant="outlined"
            color="primary"
            startIcon={<PlayArrow />}
            onClick={() => handleSubmit('continue')}
            fullWidth
          >
            Continue
          </Button>
          {onSchedule && (
            <Button
              variant="outlined"
              color="secondary"
              startIcon={<Schedule />}
              onClick={handleScheduleClick}
              fullWidth
            >
              Schedule
            </Button>
          )}
        </Box>
      )}

      {/* File Browser Dialog */}
      <Dialog
        open={fileBrowserOpen}
        onClose={() => setFileBrowserOpen(false)}
        maxWidth="md"
        fullWidth
        disableRestoreFocus
      >
        <DialogTitle>
          {fileBrowserSelectDirectory
            ? 'Select Directory'
            : fileBrowserMultiSelect
            ? 'Select Multiple Files'
            : fileBrowserAllowPattern
            ? 'Select File or Pattern'
            : 'Select File'}
        </DialogTitle>
        <DialogContent sx={{ height: '60vh' }}>
          <FileBrowser
            key={fileBrowserKey}
            onFileSelect={handleFileSelect}
            onMultiFileSelect={handleMultiFileSelect}
            rootPath={effectiveProjectDir}
            selectDirectory={fileBrowserSelectDirectory}
            allowPattern={fileBrowserAllowPattern}
            multiSelect={fileBrowserMultiSelect}
            fileFilter={fileBrowserFileFilter}
            nodeType={fileBrowserNodeType}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFileBrowserOpen(false)}>Cancel</Button>
        </DialogActions>
      </Dialog>

      <UploadDialog
        open={uploadFor !== null}
        onClose={() => setUploadFor(null)}
        projectDir={effectiveProjectDir}
        onUploaded={(path) => {
          if (uploadFor) handleParameterChange(uploadFor, path);
          setUploadFor(null);
        }}
      />
    </Paper>
  );
};

export default JobConfigForm;
