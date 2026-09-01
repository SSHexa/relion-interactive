import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSocketEvent } from '../contexts/SocketContext';
import {
  Box,
  Paper,
  Typography,
  Tabs,
  Tab,
  Grid,
  Card,
  CardContent,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Chip,
  CircularProgress,
  IconButton,
  Tooltip,
  Button,
  LinearProgress,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
} from '@mui/material';
import {
  Timeline,
  Assessment,
  InsertDriveFile,
  Image as ImageIcon,
  PictureAsPdf,
  Description,
  Download,
  Refresh,
  TrendingUp,
  Speed,
  Terminal,
  PlayArrow,
  CheckCircle,
  ViewInAr,
  NavigateBefore,
  NavigateNext,
  OpenInNew,
} from '@mui/icons-material';
import VolumeViewer3D from './VolumeViewer3D';
import { Class2DSelectionDialog } from './Class2DSelectionDialog';
import { Class3DSelectionDialog } from './Class3DSelectionDialog';
import ParticlePickerDialog from './ParticlePickerDialog';
import Results3DDialog from './Results3DDialog';
import { JobType3D } from './results3d/types';
import { getAppBasePath } from '../services/api';
import { useThemeContext } from '../contexts/ThemeContext';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  Legend,
  BarChart,
  Bar,
} from 'recharts';

interface JobResults {
  jobId: string;
  jobType: string;
  outputFiles: Array<{ name: string; path: string; size: number; type: string }>;
  images: Array<{ name: string; path: string; size: number; type: string }>;
  starFiles: Array<{ name: string; path: string; size: number }>;
  pdfs: Array<{ name: string; path: string; size: number }>;
  stats: {
    micrographCount?: number;
    motionTotal?: { min: number; max: number; mean: number; values: number[] };
    motionEarly?: { min: number; max: number; mean: number; values: number[] };
    motionLate?: { min: number; max: number; mean: number; values: number[] };
    defocus?: { min: number; max: number; mean: number; values: number[] };
    resolution?: { min: number; max: number; mean: number; values: number[] };
    // AutoPick stats
    particleCount?: number;
    particlesPerMicrograph?: { micrograph: string; count: number }[];
    fomDistribution?: { min: number; max: number; mean: number; values: number[] };
    // CtfRefine stats
    ctfRefined?: boolean;
    logfilePath?: string;
  };
  // AutoPick specific data
  autopickData?: {
    particles: Array<{ x: number; y: number; fom: number; micrograph: string }>;
    visualizationUrl?: string;
  };
}

interface JobStatus {
  // Status codes: 0=scheduled, 1=running, 2=finished, 3=aborted, 4=failed
  status: number;
  pid?: number;
  start_time?: string;
  end_time?: string;
}

interface ShiftData {
  micrograph: string;
  shifts: Array<{ frame: number; shiftX: number; shiftY: number }>;
}

interface ResultsViewerProps {
  processId: string;
  jobType: string;
  projectPath?: string;
}

const API_BASE = getAppBasePath();

const ResultsViewer: React.FC<ResultsViewerProps> = ({ processId, jobType, projectPath }) => {
  const { isDarkMode: isDark } = useThemeContext();
  const [activeTab, setActiveTab] = useState(0);

  // Helper to append project_dir to API URLs for stateless project resolution
  const withProject = (url: string) => {
    if (!projectPath) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}project_dir=${encodeURIComponent(projectPath)}`;
  };
  const [results, setResults] = useState<JobResults | null>(null);
  const [shifts, setShifts] = useState<ShiftData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatingViz, setGeneratingViz] = useState(false);
  const [micrographList, setMicrographList] = useState<Array<{name: string; particles: number; imageUrl: string}>>([]);
  const [currentMicrographIndex, setCurrentMicrographIndex] = useState(0);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [extractMontageUrl, setExtractMontageUrl] = useState<string | null>(null);
  const [generatingExtractViz, setGeneratingExtractViz] = useState(false);
  const [logContent, setLogContent] = useState<string>('');
  const logRef = useRef<HTMLPreElement>(null);
  const statusIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Particle picker dialog state
  const [particlePickerOpen, setParticlePickerOpen] = useState(false);
  const [particlePickerCtfJob, setParticlePickerCtfJob] = useState<string | undefined>();
  const [particlePickerAutopickJob, setParticlePickerAutopickJob] = useState<string | undefined>();
  const [particlePickerManualpickJob, setParticlePickerManualpickJob] = useState<string | undefined>();

  // Results3D dialog state
  const [results3DDialogOpen, setResults3DDialogOpen] = useState(false);

  const loadResults = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(withProject(`${API_BASE}/api/jobs/${processId}/results`));
      if (!response.ok) throw new Error('Failed to load results');
      const data = await response.json();
      setResults(data);

      // Load shift data for motion correction jobs
      if (jobType === 'MotionCorr') {
        const shiftsResponse = await fetch(withProject(`${API_BASE}/api/jobs/${processId}/shifts`));
        if (shiftsResponse.ok) {
          const shiftsData = await shiftsResponse.json();
          setShifts(shiftsData);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const loadJobStatus = async () => {
    try {
      const response = await fetch(withProject(`${API_BASE}/api/pipeline/processes/${processId}/status`));
      if (response.ok) {
        const data = await response.json();
        setJobStatus(data);

        // Always load log content for running/scheduled jobs or when we don't have it yet
        // Status codes: 0=scheduled, 1=running, 2=finished, 3=aborted, 4=failed
        if (data.status === 0 || data.status === 1 || !logContent) {
          loadLogContent();
        }
      } else if (response.status === 401 || response.status === 404) {
        // Job no longer exists - stop polling
        console.warn(`Job ${processId} not found (${response.status}), stopping status polling`);
        if (statusIntervalRef.current) {
          clearInterval(statusIntervalRef.current);
          statusIntervalRef.current = null;
        }
      }
    } catch (err) {
      console.error('Failed to load job status:', err);
    }
  };

  const loadLogContent = async () => {
    try {
      const response = await fetch(withProject(`${API_BASE}/api/pipeline/processes/${processId}/log?tail=200`));
      if (response.ok) {
        const data = await response.json();
        // Backend returns {stdout: string, stderr: string} - combine them
        const stdout = data.stdout || '';
        const stderr = data.stderr || '';
        const combinedLog = stdout + (stderr ? '\n--- STDERR ---\n' + stderr : '');
        setLogContent(combinedLog.trim());

        // Auto-scroll to bottom
        if (logRef.current) {
          logRef.current.scrollTop = logRef.current.scrollHeight;
        }
      }
    } catch (err) {
      console.error('Failed to load log:', err);
    }
  };

  // Parse iteration info from log content
  const parseIterationInfo = (log: string): { iteration: number; total: number; timePerIter: string; resolution: string } | null => {
    const lines = log.split('\n').filter(l => l.trim());
    let iteration = 0;
    let total = 25;
    let timePerIter = '';
    let resolution = '';

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];

      // Match "Expectation iteration X of Y" (Class2D/Class3D)
      const iterMatch = line.match(/Expectation iteration (\d+) of (\d+)/);
      if (iterMatch && !iteration) {
        iteration = parseInt(iterMatch[1]);
        total = parseInt(iterMatch[2]);
      }

      // Match "Expectation iteration X" without total (Refine3D auto-refine)
      const autoRefineIterMatch = line.match(/Expectation iteration (\d+)$/);
      if (autoRefineIterMatch && !iteration) {
        iteration = parseInt(autoRefineIterMatch[1]);
        total = 0; // Unknown total for auto-refine (converges automatically)
      }

      // Match "Auto-refine: Iteration= X" (Refine3D)
      const refine3dIterMatch = line.match(/Auto-refine: Iteration=\s*(\d+)/);
      if (refine3dIterMatch && !iteration) {
        iteration = parseInt(refine3dIterMatch[1]);
        total = 0; // Unknown total for auto-refine
      }

      // Match SGD/Gradient iteration for InitialModel: "Gradient optimisation iteration X of Y"
      const gradIterMatch = line.match(/Gradient optimisation iteration (\d+) of (\d+)/i);
      if (gradIterMatch && !iteration) {
        iteration = parseInt(gradIterMatch[1]);
        total = parseInt(gradIterMatch[2]);
      }

      // Match alternative SGD format: "SGD iteration X of Y"
      const sgdIterMatch = line.match(/SGD iteration (\d+) of (\d+)/i);
      if (sgdIterMatch && !iteration) {
        iteration = parseInt(sgdIterMatch[1]);
        total = parseInt(sgdIterMatch[2]);
      }

      // Match time estimate like "1.20/1.43 min"
      const timeMatch = line.match(/(\d+\.\d+)\/(\d+\.\d+) min/);
      if (timeMatch && !timePerIter) {
        timePerIter = `${timeMatch[1]}/${timeMatch[2]} min`;
      }

      // Match resolution like "CurrentResolution= 36.5714 Angstroms"
      const resMatch = line.match(/CurrentResolution=\s*([\d.]+)\s*Angstroms/);
      if (resMatch && !resolution) {
        resolution = `${parseFloat(resMatch[1]).toFixed(1)} Å`;
      }

      // Match alternative resolution format for SGD
      const resMatch2 = line.match(/resolution[:\s]+(\d+\.?\d*)\s*[AÅ]/i);
      if (resMatch2 && !resolution) {
        resolution = `${parseFloat(resMatch2[1]).toFixed(1)} Å`;
      }

      if (iteration && (timePerIter || resolution)) break;
    }

    if (iteration) {
      return { iteration, total, timePerIter, resolution };
    }
    return null;
  };

  useEffect(() => {
    loadResults();
    loadJobStatus();

    // Fallback polling in case the SocketIO connection drops (below).
    // Refresh both status AND the results panel so live values like Total
    // Motion / Early Motion update as the job progresses, not just status.
    statusIntervalRef.current = setInterval(() => {
      loadJobStatus();
      loadResults();
    }, 5000);

    return () => {
      if (statusIntervalRef.current) {
        clearInterval(statusIntervalRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processId]);

  // Live push updates: when the backend emits process_status_change for THIS
  // job, refresh the panel immediately (no waiting on the 5s poll).
  const handleStatusChange = useCallback(
    (payload: { id?: string; state?: string }) => {
      if (payload && payload.id === processId) {
        loadJobStatus();
        loadResults();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [processId]
  );
  useSocketEvent('process_status_change', handleStatusChange);

  // Stop auto-refresh when job completes
  // Status codes: 0=scheduled, 1=running, 2=finished, 3=aborted, 4=failed
  useEffect(() => {
    if (jobStatus && jobStatus.status !== 0 && jobStatus.status !== 1) {
      if (statusIntervalRef.current) {
        clearInterval(statusIntervalRef.current);
        statusIntervalRef.current = null;
      }
      // Reload results when job completes
      loadResults();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobStatus]);

  const generateVisualization = async () => {
    setGeneratingViz(true);
    console.log('Starting visualization generation...');
    try {
      const response = await fetch(withProject(`${API_BASE}/api/jobs/${processId}/generate-visualization`), {
        method: 'POST',
      });
      console.log('Response status:', response.status);
      if (response.ok) {
        const data = await response.json();
        console.log('Response data:', data);
        console.log('Micrographs count:', data.micrographs?.length);
        if (data.micrographs && data.micrographs.length > 0) {
          // New format: list of individual micrographs
          console.log('Setting micrographList with', data.micrographs.length, 'items');
          setMicrographList(data.micrographs);
          setCurrentMicrographIndex(0);
        } else if (data.visualizationUrl && results) {
          // Legacy format: single visualization URL
          console.log('Using legacy format with visualizationUrl');
          setResults({
            ...results,
            autopickData: {
              ...results.autopickData,
              particles: results.autopickData?.particles || [],
              visualizationUrl: data.visualizationUrl,
            },
          });
        } else {
          console.log('No micrographs or visualizationUrl in response');
        }
      } else {
        console.error('Response not OK:', response.status);
      }
    } catch (err) {
      console.error('Failed to generate visualization:', err);
    } finally {
      console.log('Finished, setting generatingViz to false');
      setGeneratingViz(false);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Status codes: 0=scheduled, 1=running, 2=finished, 3=aborted, 4=failed
  const isJobRunning = jobStatus?.status === 1 || jobStatus?.status === 0;
  const iterInfo = logContent ? parseIterationInfo(logContent) : null;

  const renderJobStatus = () => {
    // Show status if job is running OR if we have iteration info to display
    if (!isJobRunning && !iterInfo) return null;

    const progress = iterInfo && iterInfo.total > 0 ? (iterInfo.iteration / iterInfo.total) * 100 : 0;
    const isAutoRefine = iterInfo && iterInfo.total === 0;

    // Determine status text based on job status code
    const getStatusInfo = () => {
      if (!jobStatus) return { text: 'Loading...', color: 'text.secondary', icon: <CircularProgress size={20} /> };
      switch (jobStatus.status) {
        case 0: return { text: 'Scheduled', color: 'warning.main', icon: <CircularProgress size={20} /> };
        case 1: return { text: 'Running', color: 'primary.main', icon: <CircularProgress size={20} /> };
        case 2: return { text: 'Completed', color: 'success.main', icon: <CheckCircle color="success" /> };
        case 3: return { text: 'Aborted', color: 'error.main', icon: <CheckCircle color="error" /> };
        case 4: return { text: 'Failed', color: 'error.main', icon: <CheckCircle color="error" /> };
        default: return { text: 'Unknown', color: 'text.secondary', icon: <CircularProgress size={20} /> };
      }
    };

    const statusInfo = getStatusInfo();

    return (
      <Paper sx={{ p: 2, mb: 3, bgcolor: 'background.default' }}>
        <Box display="flex" alignItems="center" gap={1} mb={2}>
          {statusInfo.icon}
          <Typography variant="h6" color={statusInfo.color}>
            Job {statusInfo.text}
          </Typography>
        </Box>

        {iterInfo && (
          <>
            <Grid container spacing={2} sx={{ mb: 2 }}>
              <Grid item xs={6} sm={3}>
                <Card variant="outlined">
                  <CardContent sx={{ py: 1, '&:last-child': { pb: 1 } }}>
                    <Typography variant="caption" color="text.secondary">
                      Iteration
                    </Typography>
                    <Typography variant="h5">
                      {isAutoRefine ? iterInfo.iteration : `${iterInfo.iteration} / ${iterInfo.total}`}
                    </Typography>
                    {isAutoRefine && (
                      <Typography variant="caption" color="text.secondary">
                        (converges automatically)
                      </Typography>
                    )}
                  </CardContent>
                </Card>
              </Grid>
              <Grid item xs={6} sm={3}>
                <Card variant="outlined">
                  <CardContent sx={{ py: 1, '&:last-child': { pb: 1 } }}>
                    <Typography variant="caption" color="text.secondary">
                      {isAutoRefine ? 'Status' : 'Progress'}
                    </Typography>
                    <Typography variant="h5">
                      {isAutoRefine ? 'Refining...' : `${progress.toFixed(0)}%`}
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid item xs={6} sm={3}>
                <Card variant="outlined">
                  <CardContent sx={{ py: 1, '&:last-child': { pb: 1 } }}>
                    <Typography variant="caption" color="text.secondary">
                      Time/Iteration
                    </Typography>
                    <Typography variant="h6">
                      {iterInfo.timePerIter || '—'}
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid item xs={6} sm={3}>
                <Card variant="outlined">
                  <CardContent sx={{ py: 1, '&:last-child': { pb: 1 } }}>
                    <Typography variant="caption" color="text.secondary">
                      Resolution
                    </Typography>
                    <Typography variant="h6">
                      {iterInfo.resolution || '—'}
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
            </Grid>

            {!isAutoRefine && (
              <Box sx={{ mb: 2 }}>
                <Box display="flex" justifyContent="space-between" mb={0.5}>
                  <Typography variant="body2">Progress</Typography>
                  <Typography variant="body2">{progress.toFixed(1)}%</Typography>
                </Box>
                <LinearProgress
                  variant="determinate"
                  value={progress}
                  sx={{ height: 8, borderRadius: 1 }}
                />
              </Box>
            )}

            {isAutoRefine && (
              <Box sx={{ mb: 2 }}>
                <LinearProgress
                  variant="indeterminate"
                  sx={{ height: 8, borderRadius: 1 }}
                />
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Auto-refine runs until convergence (typically 15-30 iterations)
                </Typography>
              </Box>
            )}

            {!isAutoRefine && iterInfo.total > 0 && iterInfo.iteration && (
              <Typography variant="body2" color="text.secondary">
                Estimated remaining: ~{((iterInfo.total - iterInfo.iteration) * 1.6).toFixed(0)} minutes
              </Typography>
            )}
          </>
        )}

        {/* Show message when running but no iteration info yet */}
        {isJobRunning && !iterInfo && (
          <Box>
            <LinearProgress sx={{ height: 8, borderRadius: 1, mb: 1 }} />
            <Typography variant="body2" color="text.secondary">
              Job is starting up... Waiting for progress information.
            </Typography>
          </Box>
        )}
      </Paper>
    );
  };

  const renderLogOutput = () => {
    if (!logContent) return null;

    // Get last 50 lines for display
    const lines = logContent.split('\n');
    const displayLines = lines.slice(-50).join('\n');

    return (
      <Paper sx={{ p: 2, mb: 3 }}>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
          <Box display="flex" alignItems="center" gap={1}>
            <Terminal />
            <Typography variant="h6">Live Output</Typography>
            {isJobRunning && <Chip label="Live" color="success" size="small" />}
          </Box>
        </Box>
        <Box
          ref={logRef}
          component="pre"
          sx={{
            bgcolor: '#020509',
            color: '#d4d4d4',
            p: 2,
            borderRadius: 1,
            overflow: 'auto',
            maxHeight: 300,
            fontSize: '0.75rem',
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            m: 0,
          }}
        >
          {displayLines || 'No output yet...'}
        </Box>
      </Paper>
    );
  };

  const [class2dVisualization, setClass2dVisualization] = useState<string | null>(null);
  const [generatingClass2dViz, setGeneratingClass2dViz] = useState(false);

  const generateClass2DVisualization = async () => {
    setGeneratingClass2dViz(true);
    try {
      const response = await fetch(withProject(`${API_BASE}/api/jobs/${processId}/generate-class2d-visualization`), {
        method: 'POST',
      });
      if (response.ok) {
        const data = await response.json();
        if (data.visualizationUrl) {
          setClass2dVisualization(data.visualizationUrl);
        }
      }
    } catch (err) {
      console.error('Failed to generate Class2D visualization:', err);
    } finally {
      setGeneratingClass2dViz(false);
    }
  };

  // Check if class_averages.png already exists
  useEffect(() => {
    if (jobType === 'Class2D' && results) {
      // Check if visualization already exists
      const existingViz = results.images?.find(img => img.name === 'class_averages.png');
      if (existingViz) {
        setClass2dVisualization(`/api/jobs/${processId}/file/class_averages.png`);
      }
    }
  }, [jobType, results, processId]);

  // Class2D selection dialog state
  const [class2dSelectionOpen, setClass2dSelectionOpen] = useState(false);
  const [selectedParticlesPath, setSelectedParticlesPath] = useState<string | null>(null);

  // Class3D selection dialog state
  const [class3dSelectionOpen, setClass3dSelectionOpen] = useState(false);
  const [selectedClass3dParticlesPath, setSelectedClass3dParticlesPath] = useState<string | null>(null);

  const handleClass2DSave = (outputPath: string) => {
    setSelectedParticlesPath(outputPath);
    console.log('Saved selected particles to:', outputPath);
  };

  const handleClass2DRun = (outputPath: string) => {
    setSelectedParticlesPath(outputPath);
    console.log('Run with selected particles:', outputPath);
  };

  const handleClass3DSave = (outputPath: string) => {
    setSelectedClass3dParticlesPath(outputPath);
    console.log('Saved selected Class3D particles to:', outputPath);
  };

  const handleClass3DRun = (outputPath: string) => {
    setSelectedClass3dParticlesPath(outputPath);
    console.log('Run with selected Class3D particles:', outputPath);
  };

  // Keyboard navigation for micrograph browsing
  useEffect(() => {
    if (micrographList.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        setCurrentMicrographIndex(prev => Math.max(0, prev - 1));
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        setCurrentMicrographIndex(prev => Math.min(micrographList.length - 1, prev + 1));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [micrographList.length]);

  // Auto-generate visualization for AutoPick jobs when results are loaded
  useEffect(() => {
    if (
      jobType === 'AutoPick' &&
      results?.stats?.particleCount &&
      results.stats.particleCount > 0 &&
      micrographList.length === 0 &&
      !generatingViz
    ) {
      generateVisualization();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobType, results, micrographList.length, generatingViz]);

  // Auto-generate visualization for Extract jobs when results are loaded
  useEffect(() => {
    if (
      jobType === 'Extract' &&
      results?.stats?.particleCount &&
      results.stats.particleCount > 0 &&
      !extractMontageUrl &&
      !generatingExtractViz
    ) {
      generateExtractVisualization();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobType, results, extractMontageUrl, generatingExtractViz]);

  const generateExtractVisualization = async () => {
    setGeneratingExtractViz(true);
    try {
      const response = await fetch(withProject(`${API_BASE}/api/jobs/${processId}/generate-extract-visualization`), {
        method: 'POST',
      });
      if (response.ok) {
        const data = await response.json();
        if (data.imageUrl) {
          setExtractMontageUrl(data.imageUrl);
        }
      }
    } catch (err) {
      console.error('Failed to generate extract visualization:', err);
    } finally {
      setGeneratingExtractViz(false);
    }
  };

  // InitialModel visualization state
  const [initialModelVisualization, setInitialModelVisualization] = useState<string | null>(null);
  const [generatingInitialModelViz, setGeneratingInitialModelViz] = useState(false);

  const generateInitialModelVisualization = async () => {
    setGeneratingInitialModelViz(true);
    try {
      const response = await fetch(withProject(`${API_BASE}/api/jobs/${processId}/generate-initialmodel-visualization`), {
        method: 'POST',
      });
      if (response.ok) {
        const data = await response.json();
        if (data.visualizationUrl) {
          setInitialModelVisualization(data.visualizationUrl);
        }
      }
    } catch (err) {
      console.error('Failed to generate InitialModel visualization:', err);
    } finally {
      setGeneratingInitialModelViz(false);
    }
  };

  // Check if initial_model_slices.png already exists
  useEffect(() => {
    if (jobType === 'InitialModel' && results) {
      const existingViz = results.images?.find(img => img.name === 'initial_model_slices.png');
      if (existingViz) {
        setInitialModelVisualization(`/api/jobs/${processId}/file/initial_model_slices.png`);
      }
    }
  }, [jobType, results, processId]);

  // Refine3D visualization state
  const [refine3dVisualization, setRefine3dVisualization] = useState<string | null>(null);
  const [generatingRefine3dViz, setGeneratingRefine3dViz] = useState(false);
  const [refine3dInfo, setRefine3dInfo] = useState<{ resolution?: number; voxelSize?: number } | null>(null);

  const generateRefine3DVisualization = async () => {
    setGeneratingRefine3dViz(true);
    try {
      const response = await fetch(withProject(`${API_BASE}/api/jobs/${processId}/generate-refine3d-visualization`), {
        method: 'POST',
      });
      if (response.ok) {
        const data = await response.json();
        if (data.visualizationUrl) {
          setRefine3dVisualization(data.visualizationUrl);
          setRefine3dInfo({
            resolution: data.finalResolution,
            voxelSize: data.voxelSize,
          });
        }
      }
    } catch (err) {
      console.error('Failed to generate Refine3D visualization:', err);
    } finally {
      setGeneratingRefine3dViz(false);
    }
  };

  // Check if refine3d_visualization.png already exists
  useEffect(() => {
    if (jobType === 'Refine3D' && results) {
      const existingViz = results.images?.find(img => img.name === 'refine3d_visualization.png');
      if (existingViz) {
        setRefine3dVisualization(`/api/jobs/${processId}/file/refine3d_visualization.png`);
      }
    }
  }, [jobType, results, processId]);

  // PostProcess visualization state
  const [postprocessVisualization, setPostprocessVisualization] = useState<string | null>(null);
  const [generatingPostprocessViz, setGeneratingPostprocessViz] = useState(false);
  const [postprocessInfo, setPostprocessInfo] = useState<{ resolution?: number; voxelSize?: number } | null>(null);

  const generatePostProcessVisualization = async () => {
    setGeneratingPostprocessViz(true);
    try {
      const response = await fetch(withProject(`${API_BASE}/api/jobs/${processId}/generate-postprocess-visualization`), {
        method: 'POST',
      });
      if (response.ok) {
        const data = await response.json();
        if (data.visualizationUrl) {
          setPostprocessVisualization(data.visualizationUrl);
          setPostprocessInfo({
            resolution: data.finalResolution,
            voxelSize: data.voxelSize,
          });
        }
      }
    } catch (err) {
      console.error('Failed to generate PostProcess visualization:', err);
    } finally {
      setGeneratingPostprocessViz(false);
    }
  };

  // Check if postprocess_visualization.png already exists
  useEffect(() => {
    if (jobType === 'PostProcess' && results) {
      const existingViz = results.images?.find(img => img.name === 'postprocess_visualization.png');
      if (existingViz) {
        setPostprocessVisualization(`/api/jobs/${processId}/file/postprocess_visualization.png`);
      }
    }
  }, [jobType, results, processId]);

  // Class3D visualization state
  const [class3dVisualization, setClass3dVisualization] = useState<string | null>(null);
  const [generatingClass3dViz, setGeneratingClass3dViz] = useState(false);
  const [class3dInfo, setClass3dInfo] = useState<{ iteration?: number; numClasses?: number; classDistributions?: Record<number, number> } | null>(null);

  const generateClass3DVisualization = async () => {
    setGeneratingClass3dViz(true);
    try {
      const response = await fetch(withProject(`${API_BASE}/api/jobs/${processId}/generate-class3d-visualization`), {
        method: 'POST',
      });
      if (response.ok) {
        const data = await response.json();
        if (data.visualizationUrl) {
          setClass3dVisualization(data.visualizationUrl);
          setClass3dInfo({
            iteration: data.iteration,
            numClasses: data.numClasses,
            classDistributions: data.classDistributions,
          });
        }
      }
    } catch (err) {
      console.error('Failed to generate Class3D visualization:', err);
    } finally {
      setGeneratingClass3dViz(false);
    }
  };

  // Check if class3d_visualization.png already exists
  useEffect(() => {
    if (jobType === 'Class3D' && results) {
      const existingViz = results.images?.find(img => img.name === 'class3d_visualization.png');
      if (existingViz) {
        setClass3dVisualization(`/api/jobs/${processId}/file/class3d_visualization.png`);
      }
    }
  }, [jobType, results, processId]);

  const renderClass2DResults = () => {
    return (
      <Box>
        {renderJobStatus()}

        {/* Show class averages visualization */}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h6">
              <ImageIcon sx={{ mr: 1, verticalAlign: 'middle' }} />
              2D Class Averages
            </Typography>
            {!isJobRunning && (
              <Button
                variant="contained"
                color="primary"
                onClick={() => setClass2dSelectionOpen(true)}
                startIcon={<CheckCircle />}
              >
                Select Classes
              </Button>
            )}
          </Box>
          {class2dVisualization ? (
            <Box
              component="img"
              src={`${API_BASE}${class2dVisualization}`}
              alt="Class averages"
              sx={{
                width: '100%',
                maxHeight: 800,
                objectFit: 'contain',
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'divider',
              }}
            />
          ) : (
            <Box textAlign="center" py={4}>
              <Typography color="text.secondary" gutterBottom>
                {isJobRunning
                  ? 'Class averages will be available when the job completes.'
                  : 'No visualization available yet.'}
              </Typography>
              {!isJobRunning && (
                <Button
                  variant="contained"
                  onClick={generateClass2DVisualization}
                  disabled={generatingClass2dViz}
                  startIcon={generatingClass2dViz ? <CircularProgress size={20} /> : <ImageIcon />}
                >
                  {generatingClass2dViz ? 'Generating...' : 'Generate Class Averages Image'}
                </Button>
              )}
            </Box>
          )}
        </Paper>

        {/* Show selected particles path if available */}
        {selectedParticlesPath && (
          <Paper sx={{ p: 2, mb: 3, bgcolor: 'success.dark' }}>
            <Typography variant="body2" sx={{ color: 'white' }}>
              <CheckCircle sx={{ mr: 1, verticalAlign: 'middle', fontSize: 18 }} />
              Selected particles saved to: {selectedParticlesPath}
            </Typography>
          </Paper>
        )}

        {/* Class2D Selection Dialog */}
        <Class2DSelectionDialog
          open={class2dSelectionOpen}
          onClose={() => setClass2dSelectionOpen(false)}
          jobId={processId}
          onSave={handleClass2DSave}
          onRun={handleClass2DRun}
        />
      </Box>
    );
  };

  const renderInitialModelResults = () => {
    return (
      <Box>
        {renderJobStatus()}

        {/* View 3D Results Button */}
        <Box sx={{ mb: 2 }}>
          <Button
            variant="contained"
            startIcon={<ViewInAr />}
            onClick={() => setResults3DDialogOpen(true)}
            sx={{
              background: isDark ? 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)' : 'linear-gradient(135deg, #3B82F6 0%, #1E40AF 100%)',
              '&:hover': {
                background: 'linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)',
              },
            }}
          >
            View 3D Results
          </Button>
        </Box>

        {/* Show 3D model slices visualization */}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            <ImageIcon sx={{ mr: 1, verticalAlign: 'middle' }} />
            Initial 3D Model
          </Typography>
          {initialModelVisualization ? (
            <Box
              component="img"
              src={`${API_BASE}${initialModelVisualization}`}
              alt="Initial model slices"
              sx={{
                width: '100%',
                maxHeight: 600,
                objectFit: 'contain',
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'divider',
              }}
            />
          ) : (
            <Box textAlign="center" py={4}>
              <Typography color="text.secondary" gutterBottom>
                {isJobRunning
                  ? 'Initial model visualization will be available when the job completes.'
                  : 'No visualization available yet.'}
              </Typography>
              {!isJobRunning && (
                <Button
                  variant="contained"
                  onClick={generateInitialModelVisualization}
                  disabled={generatingInitialModelViz}
                  startIcon={generatingInitialModelViz ? <CircularProgress size={20} /> : <ImageIcon />}
                >
                  {generatingInitialModelViz ? 'Generating...' : 'Generate 3D Model Slices'}
                </Button>
              )}
            </Box>
          )}
        </Paper>

        {/* Interactive 3D Viewer */}
        {!isJobRunning && (
          <Box sx={{ mb: 3 }}>
            <VolumeViewer3D
              jobId={processId}
              title="Interactive Initial Model Viewer"
            />
          </Box>
        )}

        {/* Info about the output */}
        {!isJobRunning && (
          <Paper sx={{ p: 2, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              Output Information
            </Typography>
            <Typography variant="body2" color="text.secondary">
              The initial model can be used as a reference for:
            </Typography>
            <List dense>
              <ListItem>
                <ListItemIcon><TrendingUp fontSize="small" /></ListItemIcon>
                <ListItemText primary="3D Classification" secondary="Use as initial reference for heterogeneity analysis" />
              </ListItem>
              <ListItem>
                <ListItemIcon><TrendingUp fontSize="small" /></ListItemIcon>
                <ListItemText primary="3D Refinement" secondary="Use as starting model for high-resolution refinement" />
              </ListItem>
            </List>
          </Paper>
        )}
      </Box>
    );
  };

  const renderRefine3DResults = () => {
    return (
      <Box>
        {renderJobStatus()}

        {/* View 3D Results Button */}
        <Box sx={{ mb: 2 }}>
          <Button
            variant="contained"
            startIcon={<ViewInAr />}
            onClick={() => setResults3DDialogOpen(true)}
            sx={{
              background: isDark ? 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)' : 'linear-gradient(135deg, #3B82F6 0%, #1E40AF 100%)',
              '&:hover': {
                background: 'linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)',
              },
            }}
          >
            View 3D Results
          </Button>
        </Box>

        {/* Summary Cards */}
        {refine3dInfo && (
          <Grid container spacing={2} sx={{ mb: 3 }}>
            {refine3dInfo.resolution && (
              <Grid item xs={12} sm={4}>
                <Card sx={{ bgcolor: 'success.dark', color: 'white' }}>
                  <CardContent>
                    <Box display="flex" alignItems="center" gap={1}>
                      <TrendingUp />
                      <Typography variant="subtitle2">Final Resolution</Typography>
                    </Box>
                    <Typography variant="h4" sx={{ mt: 1 }}>
                      {refine3dInfo.resolution.toFixed(1)} Å
                    </Typography>
                    <Typography variant="caption">FSC = 0.143 criterion</Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
            {refine3dInfo.voxelSize && (
              <Grid item xs={12} sm={4}>
                <Card sx={{ bgcolor: 'primary.dark', color: 'white' }}>
                  <CardContent>
                    <Box display="flex" alignItems="center" gap={1}>
                      <Speed />
                      <Typography variant="subtitle2">Voxel Size</Typography>
                    </Box>
                    <Typography variant="h4" sx={{ mt: 1 }}>
                      {refine3dInfo.voxelSize.toFixed(2)} Å
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
          </Grid>
        )}

        {/* Show 3D model slices + FSC visualization */}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            <ImageIcon sx={{ mr: 1, verticalAlign: 'middle' }} />
            Refined 3D Map & FSC Curve
          </Typography>
          {refine3dVisualization ? (
            <Box
              component="img"
              src={`${API_BASE}${refine3dVisualization}`}
              alt="Refine3D visualization"
              sx={{
                width: '100%',
                maxHeight: 800,
                objectFit: 'contain',
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'divider',
              }}
            />
          ) : (
            <Box textAlign="center" py={4}>
              <Typography color="text.secondary" gutterBottom>
                {isJobRunning
                  ? 'Refinement visualization will be available when the job completes.'
                  : 'No visualization available yet.'}
              </Typography>
              {!isJobRunning && (
                <Button
                  variant="contained"
                  onClick={generateRefine3DVisualization}
                  disabled={generatingRefine3dViz}
                  startIcon={generatingRefine3dViz ? <CircularProgress size={20} /> : <ImageIcon />}
                >
                  {generatingRefine3dViz ? 'Generating...' : 'Generate 3D Map & FSC Visualization'}
                </Button>
              )}
            </Box>
          )}
        </Paper>

        {/* Interactive 3D Viewer */}
        {!isJobRunning && (
          <Box sx={{ mb: 3 }}>
            <VolumeViewer3D
              jobId={processId}
              title="Interactive 3D Map Viewer"
            />
          </Box>
        )}

        {/* Info about the output */}
        {!isJobRunning && (
          <Paper sx={{ p: 2, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              Output Information
            </Typography>
            <Typography variant="body2" color="text.secondary" paragraph>
              The refined 3D map can be used for:
            </Typography>
            <List dense>
              <ListItem>
                <ListItemIcon><TrendingUp fontSize="small" /></ListItemIcon>
                <ListItemText primary="Post-processing" secondary="Apply B-factor sharpening and mask for improved visualization" />
              </ListItem>
              <ListItem>
                <ListItemIcon><TrendingUp fontSize="small" /></ListItemIcon>
                <ListItemText primary="CTF Refinement" secondary="Further improve resolution with per-particle CTF refinement" />
              </ListItem>
              <ListItem>
                <ListItemIcon><TrendingUp fontSize="small" /></ListItemIcon>
                <ListItemText primary="Model Building" secondary="Build atomic models into the density map" />
              </ListItem>
            </List>
          </Paper>
        )}
      </Box>
    );
  };

  const renderClass3DResults = () => {
    return (
      <Box>
        {renderJobStatus()}

        {/* View 3D Results Button */}
        <Box sx={{ mb: 2 }}>
          <Button
            variant="contained"
            startIcon={<ViewInAr />}
            onClick={() => setResults3DDialogOpen(true)}
            sx={{
              background: isDark ? 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)' : 'linear-gradient(135deg, #3B82F6 0%, #1E40AF 100%)',
              '&:hover': {
                background: 'linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)',
              },
            }}
          >
            View 3D Results
          </Button>
        </Box>

        {/* Summary Cards */}
        {class3dInfo && (
          <Grid container spacing={2} sx={{ mb: 3 }}>
            {class3dInfo.iteration !== undefined && (
              <Grid item xs={12} sm={4}>
                <Card sx={{ bgcolor: 'info.dark', color: 'white' }}>
                  <CardContent>
                    <Box display="flex" alignItems="center" gap={1}>
                      <TrendingUp />
                      <Typography variant="subtitle2">Iteration</Typography>
                    </Box>
                    <Typography variant="h4" sx={{ mt: 1 }}>
                      {class3dInfo.iteration}
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
            {class3dInfo.numClasses !== undefined && (
              <Grid item xs={12} sm={4}>
                <Card sx={{ bgcolor: 'primary.dark', color: 'white' }}>
                  <CardContent>
                    <Box display="flex" alignItems="center" gap={1}>
                      <ViewInAr />
                      <Typography variant="subtitle2">Number of Classes</Typography>
                    </Box>
                    <Typography variant="h4" sx={{ mt: 1 }}>
                      {class3dInfo.numClasses}
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
          </Grid>
        )}

        {/* Show 3D class visualization */}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h6">
              <ImageIcon sx={{ mr: 1, verticalAlign: 'middle' }} />
              3D Class Averages
            </Typography>
            {!isJobRunning && (
              <Button
                variant="contained"
                color="primary"
                onClick={() => setClass3dSelectionOpen(true)}
                startIcon={<ViewInAr />}
              >
                Select Classes
              </Button>
            )}
          </Box>
          {class3dVisualization ? (
            <Box
              component="img"
              src={`${API_BASE}${class3dVisualization}`}
              alt="Class3D visualization"
              sx={{
                width: '100%',
                maxHeight: 800,
                objectFit: 'contain',
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'divider',
              }}
            />
          ) : (
            <Box textAlign="center" py={4}>
              <Typography color="text.secondary" gutterBottom>
                {isJobRunning
                  ? '3D classification visualization will be available when the job completes.'
                  : 'No visualization available yet.'}
              </Typography>
              {!isJobRunning && (
                <Button
                  variant="contained"
                  onClick={generateClass3DVisualization}
                  disabled={generatingClass3dViz}
                  startIcon={generatingClass3dViz ? <CircularProgress size={20} /> : <ImageIcon />}
                >
                  {generatingClass3dViz ? 'Generating...' : 'Generate 3D Class Visualization'}
                </Button>
              )}
            </Box>
          )}
        </Paper>

        {/* Show selected particles path if available */}
        {selectedClass3dParticlesPath && (
          <Paper sx={{ p: 2, mb: 3, bgcolor: 'success.dark' }}>
            <Typography variant="body2" sx={{ color: 'white' }}>
              <CheckCircle sx={{ mr: 1, verticalAlign: 'middle', fontSize: 18 }} />
              Selected particles saved to: {selectedClass3dParticlesPath}
            </Typography>
          </Paper>
        )}

        {/* Info about the output */}
        {!isJobRunning && (
          <Paper sx={{ p: 2, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              Output Information
            </Typography>
            <Typography variant="body2" color="text.secondary" paragraph>
              Select good 3D classes for further refinement:
            </Typography>
            <List dense>
              <ListItem>
                <ListItemIcon><TrendingUp fontSize="small" /></ListItemIcon>
                <ListItemText primary="3D Auto-refine" secondary="Use good classes for high-resolution refinement" />
              </ListItem>
              <ListItem>
                <ListItemIcon><TrendingUp fontSize="small" /></ListItemIcon>
                <ListItemText primary="Further Classification" secondary="Sub-classify to separate conformational states" />
              </ListItem>
            </List>
          </Paper>
        )}

        {/* Class3D Selection Dialog */}
        <Class3DSelectionDialog
          open={class3dSelectionOpen}
          onClose={() => setClass3dSelectionOpen(false)}
          jobId={processId}
          onSave={handleClass3DSave}
          onRun={handleClass3DRun}
        />
      </Box>
    );
  };

  const renderPostProcessResults = () => {
    return (
      <Box>
        {renderJobStatus()}

        {/* View 3D Results Button */}
        <Box sx={{ mb: 2 }}>
          <Button
            variant="contained"
            startIcon={<ViewInAr />}
            onClick={() => setResults3DDialogOpen(true)}
            sx={{
              background: isDark ? 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)' : 'linear-gradient(135deg, #3B82F6 0%, #1E40AF 100%)',
              '&:hover': {
                background: 'linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)',
              },
            }}
          >
            View 3D Results
          </Button>
        </Box>

        {/* Summary Cards */}
        {postprocessInfo && (
          <Grid container spacing={2} sx={{ mb: 3 }}>
            {postprocessInfo.resolution && (
              <Grid item xs={12} sm={4}>
                <Card sx={{ bgcolor: 'success.dark', color: 'white' }}>
                  <CardContent>
                    <Box display="flex" alignItems="center" gap={1}>
                      <TrendingUp />
                      <Typography variant="subtitle2">Final Resolution</Typography>
                    </Box>
                    <Typography variant="h4" sx={{ mt: 1 }}>
                      {postprocessInfo.resolution.toFixed(2)} Å
                    </Typography>
                    <Typography variant="caption">FSC = 0.143 criterion</Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
            {postprocessInfo.voxelSize && (
              <Grid item xs={12} sm={4}>
                <Card sx={{ bgcolor: 'primary.dark', color: 'white' }}>
                  <CardContent>
                    <Box display="flex" alignItems="center" gap={1}>
                      <Speed />
                      <Typography variant="subtitle2">Voxel Size</Typography>
                    </Box>
                    <Typography variant="h4" sx={{ mt: 1 }}>
                      {postprocessInfo.voxelSize.toFixed(2)} Å
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
          </Grid>
        )}

        {/* Post-Processed Map & FSC Visualization */}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            <ImageIcon sx={{ mr: 1, verticalAlign: 'middle' }} />
            Post-Processed Map & FSC Curves
          </Typography>
          {postprocessVisualization ? (
            <Box
              component="img"
              src={`${API_BASE}${postprocessVisualization}`}
              alt="PostProcess visualization"
              sx={{
                width: '100%',
                maxHeight: 800,
                objectFit: 'contain',
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'divider',
              }}
            />
          ) : (
            <Box textAlign="center" py={4}>
              <Typography color="text.secondary" gutterBottom>
                {isJobRunning
                  ? 'FSC visualization will be available when the job completes.'
                  : 'Generate FSC curves to see resolution improvement from masking.'}
              </Typography>
              {!isJobRunning && (
                <Button
                  variant="contained"
                  onClick={generatePostProcessVisualization}
                  disabled={generatingPostprocessViz}
                  startIcon={generatingPostprocessViz ? <CircularProgress size={20} /> : <ImageIcon />}
                >
                  {generatingPostprocessViz ? 'Generating...' : 'Generate Map & FSC Visualization'}
                </Button>
              )}
            </Box>
          )}
        </Paper>

        {/* Interactive 3D Viewer */}
        {!isJobRunning && (
          <Box sx={{ mb: 3 }}>
            <VolumeViewer3D
              jobId={processId}
              mrcFile="postprocess_masked.mrc"
              title="Post-Processed 3D Map"
            />
          </Box>
        )}

        {/* Info about outputs */}
        {!isJobRunning && (
          <Paper sx={{ p: 2, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              Output Files
            </Typography>
            <List dense>
              <ListItem>
                <ListItemIcon><ViewInAr fontSize="small" /></ListItemIcon>
                <ListItemText primary="postprocess.mrc" secondary="Sharpened unmasked map" />
              </ListItem>
              <ListItem>
                <ListItemIcon><ViewInAr fontSize="small" /></ListItemIcon>
                <ListItemText primary="postprocess_masked.mrc" secondary="Sharpened masked map (recommended for visualization)" />
              </ListItem>
              <ListItem>
                <ListItemIcon><Assessment fontSize="small" /></ListItemIcon>
                <ListItemText primary="postprocess.star" secondary="FSC curves and B-factor estimation" />
              </ListItem>
            </List>
          </Paper>
        )}
      </Box>
    );
  };

  const renderLocalResResults = () => {
    const stats = (results?.stats || {}) as any;
    const mapPath = stats.localResMapPath as string | undefined;
    const generated = !!stats.localResMapGenerated;
    return (
      <Box>
        {renderJobStatus()}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            <Assessment sx={{ mr: 1, verticalAlign: 'middle' }} />
            Local Resolution
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={6} md={4}>
              <Card variant="outlined">
                <CardContent>
                  <Typography color="text.secondary" gutterBottom>Status</Typography>
                  <Typography variant="h5">
                    {generated
                      ? <Chip label="Map generated" color="success" size="small" />
                      : <Chip label="Pending" color="default" size="small" />}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
            {mapPath && (
              <Grid item xs={12} md={8}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography color="text.secondary" gutterBottom>Local-resolution map</Typography>
                    <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{mapPath}</Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
          </Grid>
        </Paper>
        {generated && (
          <Box sx={{ mb: 3 }}>
            <VolumeViewer3D
              jobId={processId}
              mrcFile="relion_locres.mrc"
              title="Local-resolution Map"
            />
          </Box>
        )}
      </Box>
    );
  };

  const renderModelAngeloResults = () => {
    const stats = (results?.stats || {}) as any;
    const modelPath = stats.atomicModelPath as string | undefined;
    const fmt = stats.atomicModelFormat as string | undefined;
    const sizeBytes = stats.atomicModelSizeBytes as number | undefined;
    const generated = !!stats.atomicModelGenerated;
    const sizeKB = sizeBytes ? (sizeBytes / 1024).toFixed(1) : null;
    return (
      <Box>
        {renderJobStatus()}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            <Assessment sx={{ mr: 1, verticalAlign: 'middle' }} />
            ModelAngelo — AI Atomic Model Building
          </Typography>
          <Typography variant="body2" color="text.secondary" paragraph>
            ModelAngelo builds an atomic model directly from a cryo-EM map using graph neural networks.
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={6} md={3}>
              <Card variant="outlined">
                <CardContent>
                  <Typography color="text.secondary" gutterBottom>Status</Typography>
                  <Typography variant="h5">
                    {generated
                      ? <Chip label="Model built" color="success" size="small" />
                      : isJobRunning ? <Chip label="Running" color="warning" size="small" />
                      : <Chip label="Pending" color="default" size="small" />}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
            {fmt && (
              <Grid item xs={6} md={3}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography color="text.secondary" gutterBottom>Format</Typography>
                    <Typography variant="h5">{fmt}</Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
            {sizeKB && (
              <Grid item xs={6} md={3}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography color="text.secondary" gutterBottom>Model size</Typography>
                    <Typography variant="h5">{sizeKB} KB</Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
            {modelPath && (
              <Grid item xs={12}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography color="text.secondary" gutterBottom>Atomic model file</Typography>
                    <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{modelPath}</Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
          </Grid>
        </Paper>
      </Box>
    );
  };

  const renderDynaMightResults = () => {
    const stats = (results?.stats || {}) as any;
    const checkpoints = stats.checkpointsFound as number | undefined;
    const latest = stats.latestCheckpoint as string | undefined;
    const latentPlots = stats.latentPlotsFound as number | undefined;
    const latentPath = stats.latentPlotPath as string | undefined;
    const deformationDirs = (stats.deformationDirs as string[] | undefined) || [];
    return (
      <Box>
        {renderJobStatus()}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            <Assessment sx={{ mr: 1, verticalAlign: 'middle' }} />
            DynaMight — Continuous Flexibility Analysis
          </Typography>
          <Typography variant="body2" color="text.secondary" paragraph>
            DynaMight learns continuous conformational landscapes and per-particle deformations.
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={6} md={3}>
              <Card variant="outlined">
                <CardContent>
                  <Typography color="text.secondary" gutterBottom>Checkpoints</Typography>
                  <Typography variant="h5">{checkpoints ?? 0}</Typography>
                </CardContent>
              </Card>
            </Grid>
            <Grid item xs={6} md={3}>
              <Card variant="outlined">
                <CardContent>
                  <Typography color="text.secondary" gutterBottom>Latent plots</Typography>
                  <Typography variant="h5">{latentPlots ?? 0}</Typography>
                </CardContent>
              </Card>
            </Grid>
            <Grid item xs={6} md={3}>
              <Card variant="outlined">
                <CardContent>
                  <Typography color="text.secondary" gutterBottom>Deformation maps</Typography>
                  <Typography variant="h5">{deformationDirs.length}</Typography>
                </CardContent>
              </Card>
            </Grid>
            {latest && (
              <Grid item xs={12}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography color="text.secondary" gutterBottom>Latest checkpoint</Typography>
                    <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{latest}</Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
            {latentPath && (
              <Grid item xs={12}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography color="text.secondary" gutterBottom>Latent-space plot</Typography>
                    <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{latentPath}</Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
            {deformationDirs.length > 0 && (
              <Grid item xs={12}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography color="text.secondary" gutterBottom>Deformation directories</Typography>
                    <List dense>
                      {deformationDirs.map((d) => (
                        <ListItem key={d}>
                          <ListItemText primary={d} />
                        </ListItem>
                      ))}
                    </List>
                  </CardContent>
                </Card>
              </Grid>
            )}
          </Grid>
        </Paper>
      </Box>
    );
  };

  const renderPolishResults = () => {
    const stats = (results?.stats || {}) as any;
    const particleCount = stats.particleCount as number | undefined;
    const polished = !!stats.polished;
    return (
      <Box>
        {renderJobStatus()}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            <Assessment sx={{ mr: 1, verticalAlign: 'middle' }} />
            Bayesian Polishing
          </Typography>
          <Typography variant="body2" color="text.secondary" paragraph>
            Per-particle motion correction and dose weighting from movie frames.
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={6} md={3}>
              <Card variant="outlined">
                <CardContent>
                  <Typography color="text.secondary" gutterBottom>Particles polished</Typography>
                  <Typography variant="h5">{particleCount?.toLocaleString() ?? 'N/A'}</Typography>
                </CardContent>
              </Card>
            </Grid>
            <Grid item xs={6} md={3}>
              <Card variant="outlined">
                <CardContent>
                  <Typography color="text.secondary" gutterBottom>Status</Typography>
                  <Typography variant="h5">
                    {polished
                      ? <Chip label="Completed" color="success" size="small" />
                      : isJobRunning ? <Chip label="Running" color="warning" size="small" />
                      : <Chip label="Pending" color="default" size="small" />}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
          </Grid>
        </Paper>
      </Box>
    );
  };

  const renderClassSelectResults = () => {
    const stats = (results?.stats || {}) as any;
    const particleCount = stats.particleCount as number | undefined;
    const micrographCount = stats.micrographCount as number | undefined;
    const selectType = stats.selectType as string | undefined;
    return (
      <Box>
        {renderJobStatus()}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            <Assessment sx={{ mr: 1, verticalAlign: 'middle' }} />
            Class Selection
          </Typography>
          <Grid container spacing={2}>
            {selectType && (
              <Grid item xs={6} md={3}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography color="text.secondary" gutterBottom>Selection type</Typography>
                    <Typography variant="h5">{selectType}</Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
            {particleCount !== undefined && (
              <Grid item xs={6} md={3}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography color="text.secondary" gutterBottom>Particles selected</Typography>
                    <Typography variant="h5">{particleCount.toLocaleString()}</Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
            {micrographCount !== undefined && (
              <Grid item xs={6} md={3}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography color="text.secondary" gutterBottom>Micrographs selected</Typography>
                    <Typography variant="h5">{micrographCount.toLocaleString()}</Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
          </Grid>
        </Paper>
      </Box>
    );
  };

  const renderImportResults = () => {
    const stats = (results?.stats || {}) as any;
    const movieCount = stats.movieCount as number | undefined;
    const micrographCount = stats.micrographCount as number | undefined;
    const importType = stats.importType as string | undefined;
    return (
      <Box>
        {renderJobStatus()}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            <Assessment sx={{ mr: 1, verticalAlign: 'middle' }} />
            Import Summary
          </Typography>
          <Grid container spacing={2}>
            {importType && (
              <Grid item xs={6} md={3}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography color="text.secondary" gutterBottom>Type</Typography>
                    <Typography variant="h5">{importType}</Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
            {movieCount !== undefined && (
              <Grid item xs={6} md={3}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography color="text.secondary" gutterBottom>Movies</Typography>
                    <Typography variant="h5">{movieCount.toLocaleString()}</Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
            {micrographCount !== undefined && (
              <Grid item xs={6} md={3}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography color="text.secondary" gutterBottom>Micrographs</Typography>
                    <Typography variant="h5">{micrographCount.toLocaleString()}</Typography>
                  </CardContent>
                </Card>
              </Grid>
            )}
          </Grid>
        </Paper>
      </Box>
    );
  };

  const renderManualPickResults = () => {
    const stats = (results?.stats || {}) as any;
    const done = !!stats.manualPickDone;
    const inputCtfJob: string | undefined = stats.inputCtfJob;
    const inputMicrographsStar: string | undefined = stats.inputMicrographsStar;

    return (
      <Box>
        {renderJobStatus()}

        {/* Summary cards */}
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <Grid item xs={12} sm={6}>
            <Card sx={{ bgcolor: 'primary.dark', color: 'white' }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1}>
                  <Assessment />
                  <Typography variant="subtitle2">Manual Picks</Typography>
                </Box>
                <Typography variant="h4" sx={{ mt: 1 }}>
                  {done ? (
                    <Chip label="Saved" color="success" size="small" />
                  ) : (
                    <Chip label="Not started" color="default" size="small" />
                  )}
                </Typography>
                <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>
                  {done ? 'Picks written to manualpick.star' : 'No picks recorded yet'}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} sm={6}>
            <Card sx={{ bgcolor: 'info.dark', color: 'white' }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1}>
                  <ImageIcon />
                  <Typography variant="subtitle2">Input Micrographs</Typography>
                </Box>
                <Typography variant="h6" sx={{ mt: 1 }}>
                  {inputCtfJob || '—'}
                </Typography>
                <Typography variant="caption" sx={{ display: 'block', mt: 1, wordBreak: 'break-all' }}>
                  {inputMicrographsStar || 'Source not detected'}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        {/* Open in Particle Picker Button */}
        <Paper sx={{ p: 2, mb: 3, bgcolor: 'background.default' }}>
          <Box display="flex" alignItems="center" justifyContent="space-between">
            <Box>
              <Typography variant="subtitle1" fontWeight="bold">
                Interactive Particle Picker
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {done
                  ? 'Reopen this ManualPick job to add, edit, or remove picks.'
                  : 'Launch the interactive picker to place particles on the input micrographs.'}
              </Typography>
            </Box>
            <Button
              variant="contained"
              color="secondary"
              startIcon={<OpenInNew />}
              onClick={() => {
                setParticlePickerCtfJob(inputCtfJob);
                setParticlePickerAutopickJob(undefined);
                setParticlePickerManualpickJob(processId);
                setParticlePickerOpen(true);
              }}
            >
              Open Particle Picker
            </Button>
          </Box>
        </Paper>
      </Box>
    );
  };

  const renderMaskCreateResults = () => {
    return (
      <Box>
        {renderJobStatus()}

        {/* Summary info */}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            <ViewInAr sx={{ mr: 1, verticalAlign: 'middle' }} />
            Solvent Mask
          </Typography>
          <Typography variant="body2" color="text.secondary" paragraph>
            A solvent mask has been created from the input 3D volume. This mask can be used for post-processing.
          </Typography>
        </Paper>

        {/* Interactive 3D Viewer */}
        {!isJobRunning && (
          <Box sx={{ mb: 3 }}>
            <VolumeViewer3D
              jobId={processId}
              mrcFile="mask.mrc"
              title="3D Mask Viewer"
            />
          </Box>
        )}

        {/* Info about usage */}
        {!isJobRunning && (
          <Paper sx={{ p: 2, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              Usage
            </Typography>
            <Typography variant="body2" color="text.secondary">
              This mask can be used in:
            </Typography>
            <List dense>
              <ListItem>
                <ListItemIcon><TrendingUp fontSize="small" /></ListItemIcon>
                <ListItemText primary="Post-processing" secondary="Apply the mask to sharpen and improve the refined map" />
              </ListItem>
              <ListItem>
                <ListItemIcon><TrendingUp fontSize="small" /></ListItemIcon>
                <ListItemText primary="3D Classification" secondary="Focus classification on specific regions" />
              </ListItem>
            </List>
          </Paper>
        )}
      </Box>
    );
  };

  const renderCtfRefineResults = () => {
    const particleCount = results?.stats?.particleCount;
    const ctfRefined = results?.stats?.ctfRefined;
    const logfilePath = results?.stats?.logfilePath;

    return (
      <Box>
        {renderJobStatus()}

        {/* Summary info */}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            <Assessment sx={{ mr: 1, verticalAlign: 'middle' }} />
            CTF Refinement Results
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={6} md={3}>
              <Card variant="outlined">
                <CardContent>
                  <Typography color="text.secondary" gutterBottom>
                    Particles Refined
                  </Typography>
                  <Typography variant="h5">
                    {particleCount?.toLocaleString() || 'N/A'}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
            <Grid item xs={6} md={3}>
              <Card variant="outlined">
                <CardContent>
                  <Typography color="text.secondary" gutterBottom>
                    Status
                  </Typography>
                  <Typography variant="h5">
                    {ctfRefined ? (
                      <Chip label="Completed" color="success" size="small" />
                    ) : isJobRunning ? (
                      <Chip label="Running" color="warning" size="small" />
                    ) : (
                      <Chip label="Pending" color="default" size="small" />
                    )}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
          </Grid>
        </Paper>

        {/* Description */}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="body2" color="text.secondary" paragraph>
            CTF refinement estimates per-particle defocus values, beam tilt, and higher-order aberrations
            to improve the CTF correction and overall map quality.
          </Typography>
          {!isJobRunning && ctfRefined && (
            <Typography variant="body2" color="text.secondary">
              The refined particle data can be used in subsequent Refine3D or Bayesian polishing jobs.
            </Typography>
          )}
        </Paper>

        {/* PDF Logfile link if available */}
        {logfilePath && (
          <Paper sx={{ p: 2, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              <PictureAsPdf sx={{ mr: 1, verticalAlign: 'middle' }} />
              Analysis Report
            </Typography>
            <Button
              variant="outlined"
              startIcon={<Download />}
              href={`${API_BASE}/api/files/download/${logfilePath}`}
              target="_blank"
            >
              Download Logfile PDF
            </Button>
          </Paper>
        )}
      </Box>
    );
  };

  const renderMotionCorrResults = () => {
    if (!results?.stats) return null;

    const { motionTotal, motionEarly, motionLate } = results.stats;

    // Prepare data for motion trajectory chart
    const trajectoryData = shifts.length > 0 ? shifts[0].shifts.map((s) => ({
      frame: s.frame,
      x: s.shiftX,
      y: s.shiftY,
    })) : [];

    // Prepare data for motion statistics
    const motionStatsData: { index: number; total: number; early: number; late: number }[] = [];
    if (motionTotal?.values) {
      motionTotal.values.forEach((v, i) => {
        motionStatsData.push({
          index: i + 1,
          total: v,
          early: motionEarly?.values?.[i] || 0,
          late: motionLate?.values?.[i] || 0,
        });
      });
    }

    return (
      <Box>
        {/* Summary Cards */}
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <Grid item xs={12} sm={4}>
            <Card sx={{ bgcolor: 'primary.dark', color: 'white' }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1}>
                  <TrendingUp />
                  <Typography variant="subtitle2">Total Motion</Typography>
                </Box>
                <Typography variant="h4" sx={{ mt: 1 }}>
                  {motionTotal?.mean?.toFixed(2) || '—'} px
                </Typography>
                <Typography variant="caption">
                  Range: {motionTotal?.min?.toFixed(1)} - {motionTotal?.max?.toFixed(1)} px
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} sm={4}>
            <Card sx={{ bgcolor: 'success.dark', color: 'white' }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1}>
                  <Speed />
                  <Typography variant="subtitle2">Early Motion</Typography>
                </Box>
                <Typography variant="h4" sx={{ mt: 1 }}>
                  {motionEarly?.mean?.toFixed(2) || '—'} px
                </Typography>
                <Typography variant="caption">
                  Range: {motionEarly?.min?.toFixed(1)} - {motionEarly?.max?.toFixed(1)} px
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} sm={4}>
            <Card sx={{ bgcolor: 'warning.dark', color: 'white' }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1}>
                  <Speed />
                  <Typography variant="subtitle2">Late Motion</Typography>
                </Box>
                <Typography variant="h4" sx={{ mt: 1 }}>
                  {motionLate?.mean?.toFixed(2) || '—'} px
                </Typography>
                <Typography variant="caption">
                  Range: {motionLate?.min?.toFixed(1)} - {motionLate?.max?.toFixed(1)} px
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        {/* Motion Trajectory Chart */}
        {trajectoryData.length > 0 && (
          <Paper sx={{ p: 2, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              Frame-by-Frame Motion Trajectory
            </Typography>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={trajectoryData} margin={{ bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="frame" label={{ value: 'Frame', position: 'insideBottom', offset: -10 }} />
                <YAxis label={{ value: 'Shift (px)', angle: -90, position: 'insideLeft' }} />
                <RechartsTooltip
                  formatter={(value: number) => value.toFixed(2)}
                  labelFormatter={(label) => `Frame ${label}`}
                />
                <Legend verticalAlign="top" />
                <Line
                  type="monotone"
                  dataKey="x"
                  name="Shift X"
                  stroke="#8884d8"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
                <Line
                  type="monotone"
                  dataKey="y"
                  name="Shift Y"
                  stroke="#82ca9d"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </Paper>
        )}

        {/* XY Scatter Plot */}
        {trajectoryData.length > 0 && (
          <Paper sx={{ p: 2, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              Motion Path (X vs Y)
            </Typography>
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="x"
                  name="Shift X"
                  type="number"
                  label={{ value: 'Shift X (px)', position: 'bottom' }}
                />
                <YAxis
                  dataKey="y"
                  name="Shift Y"
                  type="number"
                  label={{ value: 'Shift Y (px)', angle: -90, position: 'insideLeft' }}
                />
                <RechartsTooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  formatter={(value: number) => value.toFixed(2)}
                />
                <Scatter
                  name="Motion Path"
                  data={trajectoryData}
                  fill="#8884d8"
                  line={{ stroke: '#8884d8', strokeWidth: 1 }}
                />
              </ScatterChart>
            </ResponsiveContainer>
          </Paper>
        )}

        {/* Motion Distribution */}
        {motionStatsData.length > 1 && (
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" gutterBottom>
              Motion Statistics per Micrograph
            </Typography>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={motionStatsData} margin={{ bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="index" label={{ value: 'Micrograph', position: 'insideBottom', offset: -10 }} />
                <YAxis label={{ value: 'Motion (px)', angle: -90, position: 'insideLeft' }} />
                <RechartsTooltip />
                <Legend verticalAlign="top" />
                <Bar dataKey="early" name="Early Motion" fill="#10B981" stackId="a" />
                <Bar dataKey="late" name="Late Motion" fill="#F59E0B" stackId="a" />
              </BarChart>
            </ResponsiveContainer>
          </Paper>
        )}
      </Box>
    );
  };

  const renderCtfResults = () => {
    if (!results?.stats) return null;

    const { defocus, resolution, micrographCount } = results.stats;

    return (
      <Box>
        {/* Summary Cards */}
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <Grid item xs={12} sm={4}>
            <Card sx={{ bgcolor: 'primary.dark', color: 'white' }}>
              <CardContent>
                <Typography variant="subtitle2">Micrographs</Typography>
                <Typography variant="h4" sx={{ mt: 1 }}>
                  {micrographCount || 0}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} sm={4}>
            <Card sx={{ bgcolor: 'success.dark', color: 'white' }}>
              <CardContent>
                <Typography variant="subtitle2">Avg Defocus</Typography>
                <Typography variant="h4" sx={{ mt: 1 }}>
                  {defocus ? (defocus.mean / 10000).toFixed(2) : '—'} µm
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} sm={4}>
            <Card sx={{ bgcolor: 'info.dark', color: 'white' }}>
              <CardContent>
                <Typography variant="subtitle2">Avg Resolution</Typography>
                <Typography variant="h4" sx={{ mt: 1 }}>
                  {resolution?.mean?.toFixed(1) || '—'} Å
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        {/* Open in Particle Picker Button */}
        <Paper sx={{ p: 2, mb: 3, bgcolor: 'background.default' }}>
          <Box display="flex" alignItems="center" justifyContent="space-between">
            <Box>
              <Typography variant="subtitle1" fontWeight="bold">
                Interactive Particle Picker
              </Typography>
              <Typography variant="body2" color="text.secondary">
                View micrograph quality metrics and pick particles interactively
              </Typography>
            </Box>
            <Button
              variant="contained"
              color="secondary"
              startIcon={<OpenInNew />}
              onClick={() => {
                setParticlePickerCtfJob(processId);
                setParticlePickerAutopickJob(undefined);
                setParticlePickerManualpickJob(undefined);
                setParticlePickerOpen(true);
              }}
            >
              Open Particle Picker
            </Button>
          </Box>
        </Paper>

        {/* Defocus Distribution */}
        {defocus?.values && defocus.values.length > 1 && (
          <Paper sx={{ p: 2, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              Defocus Distribution
            </Typography>
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="index"
                  name="Micrograph"
                  type="number"
                />
                <YAxis
                  dataKey="defocus"
                  name="Defocus"
                  type="number"
                  tickFormatter={(v) => (v / 10000).toFixed(1)}
                />
                <RechartsTooltip
                  formatter={(value: number) => `${(value / 10000).toFixed(2)} µm`}
                />
                <Scatter
                  name="Defocus"
                  data={defocus.values.map((v, i) => ({ index: i + 1, defocus: v }))}
                  fill="#8884d8"
                />
              </ScatterChart>
            </ResponsiveContainer>
          </Paper>
        )}
      </Box>
    );
  };

  const renderAutopickResults = () => {
    if (!results?.stats) return null;

    const { particleCount, fomDistribution, particlesPerMicrograph } = results.stats;

    // Prepare FOM histogram data
    const fomHistogramData: { range: string; count: number }[] = [];
    if (fomDistribution?.values) {
      const bins = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
      const counts = new Array(bins.length - 1).fill(0);
      fomDistribution.values.forEach((fom) => {
        for (let i = 0; i < bins.length - 1; i++) {
          if (fom >= bins[i] && fom < bins[i + 1]) {
            counts[i]++;
            break;
          }
        }
      });
      bins.slice(0, -1).forEach((bin, i) => {
        fomHistogramData.push({
          range: `${bin.toFixed(1)}-${bins[i + 1].toFixed(1)}`,
          count: counts[i],
        });
      });
    }

    return (
      <Box>
        {/* Summary Cards */}
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <Grid item xs={12} sm={4}>
            <Card sx={{ bgcolor: 'primary.dark', color: 'white' }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1}>
                  <Assessment />
                  <Typography variant="subtitle2">Total Particles</Typography>
                </Box>
                <Typography variant="h4" sx={{ mt: 1 }}>
                  {particleCount || 0}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} sm={4}>
            <Card sx={{ bgcolor: 'success.dark', color: 'white' }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1}>
                  <TrendingUp />
                  <Typography variant="subtitle2">Avg FOM</Typography>
                </Box>
                <Typography variant="h4" sx={{ mt: 1 }}>
                  {fomDistribution?.mean?.toFixed(3) || '—'}
                </Typography>
                <Typography variant="caption">
                  Range: {fomDistribution?.min?.toFixed(2)} - {fomDistribution?.max?.toFixed(2)}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} sm={4}>
            <Card sx={{ bgcolor: 'info.dark', color: 'white' }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1}>
                  <ImageIcon />
                  <Typography variant="subtitle2">Micrographs</Typography>
                </Box>
                <Typography variant="h4" sx={{ mt: 1 }}>
                  {particlesPerMicrograph?.length || 0}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        {/* Open in Particle Picker Button */}
        <Paper sx={{ p: 2, mb: 3, bgcolor: 'background.default' }}>
          <Box display="flex" alignItems="center" justifyContent="space-between">
            <Box>
              <Typography variant="subtitle1" fontWeight="bold">
                Interactive Particle Picker
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Refine picks, add/remove particles, filter by quality metrics
              </Typography>
            </Box>
            <Button
              variant="contained"
              color="secondary"
              startIcon={<OpenInNew />}
              onClick={() => {
                setParticlePickerCtfJob(undefined);
                setParticlePickerAutopickJob(processId);
                setParticlePickerManualpickJob(undefined);
                setParticlePickerOpen(true);
              }}
            >
              Open Particle Picker
            </Button>
          </Box>
        </Paper>

        {/* Particle Visualization Image */}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            <ImageIcon sx={{ mr: 1, verticalAlign: 'middle' }} />
            Picked Particles Visualization
          </Typography>
          {micrographList.length > 0 ? (
            <>
              {/* Navigation Controls */}
              <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
                <IconButton
                  onClick={() => setCurrentMicrographIndex(prev => Math.max(0, prev - 1))}
                  disabled={currentMicrographIndex === 0}
                  size="large"
                >
                  <NavigateBefore />
                </IconButton>

                <Box display="flex" alignItems="center" gap={2} flexGrow={1} justifyContent="center">
                  <FormControl size="small" sx={{ minWidth: 250 }}>
                    <InputLabel>Micrograph</InputLabel>
                    <Select
                      value={currentMicrographIndex}
                      label="Micrograph"
                      onChange={(e) => setCurrentMicrographIndex(Number(e.target.value))}
                    >
                      {micrographList.map((mic, idx) => (
                        <MenuItem key={idx} value={idx}>
                          {mic.name} ({mic.particles} particles)
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Chip
                    label={`${currentMicrographIndex + 1} / ${micrographList.length}`}
                    color="primary"
                    variant="outlined"
                  />
                </Box>

                <IconButton
                  onClick={() => setCurrentMicrographIndex(prev => Math.min(micrographList.length - 1, prev + 1))}
                  disabled={currentMicrographIndex === micrographList.length - 1}
                  size="large"
                >
                  <NavigateNext />
                </IconButton>
              </Box>

              {/* Current Micrograph Image */}
              <Box
                component="img"
                src={`${API_BASE}${micrographList[currentMicrographIndex].imageUrl}`}
                alt={`Micrograph ${micrographList[currentMicrographIndex].name}`}
                sx={{
                  width: '100%',
                  maxHeight: 700,
                  objectFit: 'contain',
                  borderRadius: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              />

              {/* Info bar */}
              <Box display="flex" justifyContent="space-between" alignItems="center" mt={1}>
                <Typography variant="caption" color="text.secondary">
                  Green: FOM &gt; 0.4 | Yellow: FOM 0.2-0.4 | Orange: FOM &lt; 0.2
                </Typography>
                <Typography variant="body2" fontWeight="bold">
                  {micrographList[currentMicrographIndex].particles} particles on this micrograph
                </Typography>
              </Box>
            </>
          ) : (
            <Box textAlign="center" py={4}>
              <Typography color="text.secondary" gutterBottom>
                {results?.autopickData?.visualizationUrl
                  ? 'Click below to view individual micrographs with navigation controls.'
                  : 'No visualization available yet.'}
              </Typography>
              {generatingViz ? (
                <Box display="flex" alignItems="center" gap={2}>
                  <CircularProgress size={24} />
                  <Typography>Generating images...</Typography>
                </Box>
              ) : (
                <Button
                  variant="contained"
                  onClick={generateVisualization}
                  startIcon={<ImageIcon />}
                >
                  Generate Micrograph Browser
                </Button>
              )}
            </Box>
          )}
        </Paper>

        {/* FOM Distribution Histogram */}
        {fomHistogramData.length > 0 && (
          <Paper sx={{ p: 2, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              Figure of Merit (FOM) Distribution
            </Typography>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={fomHistogramData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="range" label={{ value: 'FOM Range', position: 'bottom' }} />
                <YAxis label={{ value: 'Count', angle: -90, position: 'insideLeft' }} />
                <RechartsTooltip />
                <Bar dataKey="count" name="Particles" fill="#10B981" />
              </BarChart>
            </ResponsiveContainer>
          </Paper>
        )}

        {/* Particles per Micrograph */}
        {particlesPerMicrograph && particlesPerMicrograph.length > 1 && (
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" gutterBottom>
              Particles per Micrograph
            </Typography>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={particlesPerMicrograph.map((p, i) => ({ ...p, index: i + 1 }))}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="index" label={{ value: 'Micrograph', position: 'bottom' }} />
                <YAxis label={{ value: 'Particles', angle: -90, position: 'insideLeft' }} />
                <RechartsTooltip
                  labelFormatter={(label) => `Micrograph ${label}`}
                />
                <Bar dataKey="count" name="Particles" fill={isDark ? '#22D3EE' : '#3B82F6'} />
              </BarChart>
            </ResponsiveContainer>
          </Paper>
        )}
      </Box>
    );
  };

  const renderExtractResults = () => {
    if (!results?.stats) return null;

    const { particleCount } = results.stats;

    return (
      <Box>
        {/* Summary Cards */}
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <Grid item xs={12} sm={4}>
            <Card sx={{ bgcolor: 'primary.dark', color: 'white' }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1}>
                  <Assessment />
                  <Typography variant="subtitle2">Extracted Particles</Typography>
                </Box>
                <Typography variant="h4" sx={{ mt: 1 }}>
                  {particleCount?.toLocaleString() || 0}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} sm={4}>
            <Card sx={{ bgcolor: 'success.dark', color: 'white' }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1}>
                  <CheckCircle />
                  <Typography variant="subtitle2">Status</Typography>
                </Box>
                <Typography variant="h4" sx={{ mt: 1 }}>
                  Complete
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} sm={4}>
            <Card sx={{ bgcolor: 'info.dark', color: 'white' }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1}>
                  <Description />
                  <Typography variant="subtitle2">Output File</Typography>
                </Box>
                <Typography variant="h6" sx={{ mt: 1 }}>
                  particles.star
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        {/* Particle Montage Visualization */}
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            Extracted Particles Preview
          </Typography>
          {generatingExtractViz ? (
            <Box display="flex" alignItems="center" gap={2} py={2}>
              <CircularProgress size={24} />
              <Typography>Generating particle montage...</Typography>
            </Box>
          ) : extractMontageUrl ? (
            <Box>
              <img
                src={`${API_BASE}${extractMontageUrl}`}
                alt="Extracted particles montage"
                style={{ width: '100%', maxWidth: '100%', borderRadius: 4 }}
              />
            </Box>
          ) : (
            <Box py={2}>
              <Button
                variant="contained"
                onClick={generateExtractVisualization}
                startIcon={<ImageIcon />}
              >
                Generate Particle Preview
              </Button>
            </Box>
          )}
        </Paper>

        {/* Summary */}
        <Paper sx={{ p: 2 }}>
          <Typography variant="h6" gutterBottom>
            Extraction Summary
          </Typography>
          <Typography variant="body2" color="text.secondary" paragraph>
            Successfully extracted {particleCount?.toLocaleString() || 0} particle images from micrographs.
            The extracted particles are saved in <code>particles.star</code> and can be used for 2D classification.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Next steps: Use the extracted particles for 2D Classification (Class2D) to sort and clean your particle dataset.
          </Typography>
        </Paper>
      </Box>
    );
  };

  const renderFiles = () => (
    <Box>
      {/* STAR Files */}
      {results?.starFiles && results.starFiles.length > 0 && (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="h6" gutterBottom>
            <Description sx={{ mr: 1, verticalAlign: 'middle' }} />
            STAR Files
          </Typography>
          <List dense>
            {results.starFiles.map((file, i) => (
              <ListItem
                key={i}
                secondaryAction={
                  <Tooltip title="Download">
                    <IconButton
                      edge="end"
                      href={`${API_BASE}/api/jobs/${processId}/file/${file.name}`}
                      download
                    >
                      <Download />
                    </IconButton>
                  </Tooltip>
                }
              >
                <ListItemIcon>
                  <Description color="info" />
                </ListItemIcon>
                <ListItemText
                  primary={file.name}
                  secondary={formatFileSize(file.size)}
                />
              </ListItem>
            ))}
          </List>
        </Paper>
      )}

      {/* Images/MRC */}
      {results?.images && results.images.length > 0 && (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="h6" gutterBottom>
            <ImageIcon sx={{ mr: 1, verticalAlign: 'middle' }} />
            Images & MRC Files
          </Typography>
          <List dense>
            {results.images.map((file, i) => (
              <ListItem
                key={i}
                secondaryAction={
                  <Box>
                    <Chip
                      label={file.type.toUpperCase()}
                      size="small"
                      sx={{ mr: 1 }}
                    />
                    <Tooltip title="Download">
                      <IconButton
                        edge="end"
                        href={`${API_BASE}/api/jobs/${processId}/file/${file.name}`}
                        download
                      >
                        <Download />
                      </IconButton>
                    </Tooltip>
                  </Box>
                }
              >
                <ListItemIcon>
                  <ImageIcon color="success" />
                </ListItemIcon>
                <ListItemText
                  primary={file.name}
                  secondary={formatFileSize(file.size)}
                />
              </ListItem>
            ))}
          </List>
        </Paper>
      )}

      {/* PDFs */}
      {results?.pdfs && results.pdfs.length > 0 && (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="h6" gutterBottom>
            <PictureAsPdf sx={{ mr: 1, verticalAlign: 'middle' }} />
            PDF Reports
          </Typography>
          <List dense>
            {results.pdfs.map((file, i) => (
              <ListItem
                key={i}
                secondaryAction={
                  <Tooltip title="Download">
                    <IconButton
                      edge="end"
                      href={`${API_BASE}/api/jobs/${processId}/file/${file.name}`}
                      download
                    >
                      <Download />
                    </IconButton>
                  </Tooltip>
                }
              >
                <ListItemIcon>
                  <PictureAsPdf color="error" />
                </ListItemIcon>
                <ListItemText
                  primary={file.name}
                  secondary={formatFileSize(file.size)}
                />
              </ListItem>
            ))}
          </List>
        </Paper>
      )}

      {/* Other Files */}
      {results?.outputFiles && results.outputFiles.length > 0 && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="h6" gutterBottom>
            <InsertDriveFile sx={{ mr: 1, verticalAlign: 'middle' }} />
            Other Files
          </Typography>
          <List dense>
            {results.outputFiles.map((file, i) => (
              <ListItem key={i}>
                <ListItemIcon>
                  <InsertDriveFile />
                </ListItemIcon>
                <ListItemText
                  primary={file.name}
                  secondary={formatFileSize(file.size)}
                />
              </ListItem>
            ))}
          </List>
        </Paper>
      )}
    </Box>
  );

  if (loading && !logContent) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !logContent) {
    return (
      <Box p={2}>
        <Typography color="error">{error}</Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
        <Typography variant="h6">
          <Assessment sx={{ mr: 1, verticalAlign: 'middle' }} />
          Job Results
          {isJobRunning && (
            <Chip
              label="Running"
              color="primary"
              size="small"
              sx={{ ml: 1, verticalAlign: 'middle' }}
              icon={<PlayArrow />}
            />
          )}
        </Typography>
        <IconButton onClick={() => { loadResults(); loadJobStatus(); }} size="small">
          <Refresh />
        </IconButton>
      </Box>

      <Tabs
        value={activeTab}
        onChange={(_, v) => setActiveTab(v)}
        sx={{ mb: 2 }}
      >
        <Tab icon={<Timeline />} label="Statistics" iconPosition="start" />
        <Tab icon={<InsertDriveFile />} label="Files" iconPosition="start" />
        <Tab icon={<Terminal />} label="Output" iconPosition="start" />
      </Tabs>

      {activeTab === 0 && (
        <Box>
          {jobType === 'Import' && renderImportResults()}
          {jobType === 'MotionCorr' && renderMotionCorrResults()}
          {jobType === 'CtfFind' && renderCtfResults()}
          {jobType === 'ManualPick' && renderManualPickResults()}
          {jobType === 'AutoPick' && renderAutopickResults()}
          {jobType === 'Extract' && renderExtractResults()}
          {jobType === 'Class2D' && renderClass2DResults()}
          {jobType === 'ClassSelect' && renderClassSelectResults()}
          {jobType === 'Class3D' && renderClass3DResults()}
          {jobType === 'InitialModel' && renderInitialModelResults()}
          {jobType === 'Refine3D' && renderRefine3DResults()}
          {jobType === 'PostProcess' && renderPostProcessResults()}
          {jobType === 'MaskCreate' && renderMaskCreateResults()}
          {jobType === 'CtfRefine' && renderCtfRefineResults()}
          {jobType === 'Polish' && renderPolishResults()}
          {jobType === 'LocalRes' && renderLocalResResults()}
          {jobType === 'ModelAngelo' && renderModelAngeloResults()}
          {jobType === 'DynaMight' && renderDynaMightResults()}
          {!['Import', 'MotionCorr', 'CtfFind', 'ManualPick', 'AutoPick', 'Extract', 'Class2D', 'ClassSelect', 'Class3D', 'InitialModel', 'Refine3D', 'PostProcess', 'MaskCreate', 'CtfRefine', 'Polish', 'LocalRes', 'ModelAngelo', 'DynaMight'].includes(jobType) && (
            <>
              {renderJobStatus()}
            </>
          )}
        </Box>
      )}

      {activeTab === 1 && renderFiles()}

      {activeTab === 2 && (
        <Box>
          {renderLogOutput()}
        </Box>
      )}

      {/* Particle Picker Dialog */}
      <ParticlePickerDialog
        open={particlePickerOpen}
        onClose={() => setParticlePickerOpen(false)}
        project={projectPath || ''}
        ctfJobId={particlePickerCtfJob}
        autopickJobId={particlePickerAutopickJob}
        manualpickJobId={particlePickerManualpickJob}
      />

      {/* Results3D Dialog for 3D job types */}
      {['Refine3D', 'InitialModel', 'Class3D', 'PostProcess'].includes(jobType) && (
        <Results3DDialog
          open={results3DDialogOpen}
          onClose={() => setResults3DDialogOpen(false)}
          jobId={processId}
          jobType={jobType as JobType3D}
          jobName={processId}
        />
      )}
    </Box>
  );
};

export default ResultsViewer;
