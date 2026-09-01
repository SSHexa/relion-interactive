import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useSocketEvent } from '../contexts/SocketContext';
import {
  Box,
  Paper,
  Typography,
  Button,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogContentText,
  Select,
  FormControl,
  InputLabel,
  MenuItem,
  Chip,
  Tooltip,
  alpha,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Snackbar,
  Alert,
  CircularProgress,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import {
  AccountTree,
  PlayArrow,
  Folder,
  Add,
  Refresh,
  CheckCircle,
  Error as ErrorIcon,
  Science,
  ChevronRight,
  ExpandMore,
  Fullscreen,
  FullscreenExit,
} from '@mui/icons-material';
import PipelineGraph from '../components/PipelineGraph';
import FileBrowser from '../components/FileBrowser';
import ProjectManager, { Project } from '../components/ProjectManager';
import { JobGrid, ProcessDetailDialog, DashboardHeader, ProjectSidebar, NewJobDialog } from '../components/dashboard';
import ParticlePickerDialog from '../components/ParticlePickerDialog';
import { Pipeline, PipelineProcess, Job, JobType, ProcessStatus } from '../types/relion';
import { getStatusInfo, StatusFilter, getStatusCounts, filterProcessesByStatus } from '../utils/statusHelpers';
import { useThemeContext } from '../contexts/ThemeContext';
import api, { getApiBaseUrl } from '../services/api';

const Dashboard: React.FC = () => {
  const { isDarkMode } = useThemeContext();
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [activeView, setActiveView] = useState<'overview' | 'pipeline' | 'jobs' | 'files' | 'projects'>(() => {
    const saved = localStorage.getItem('relion-activeView');
    if (saved && ['overview', 'pipeline', 'jobs', 'files', 'projects'].includes(saved)) {
      return saved as 'overview' | 'pipeline' | 'jobs' | 'files' | 'projects';
    }
    return 'projects';
  });

  const updateActiveView = (view: typeof activeView) => {
    localStorage.setItem('relion-activeView', view);
    setActiveView(view);
  };
  const [, setPipeline] = useState<Pipeline | null>(null);
  const [processes, setProcesses] = useState<PipelineProcess[]>([]);
  const [selectedProcess, setSelectedProcess] = useState<PipelineProcess | null>(null);
  const [newJobDialogOpen, setNewJobDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [graphFullscreen, setGraphFullscreen] = useState(false);
  const projectRestoredRef = useRef(false);

  // Confirmation dialog state for destructive actions
  const [confirmAction, setConfirmAction] = useState<{
    type: 'abort' | 'delete' | 'cleanup';
    processId: string;
    processName: string;
  } | null>(null);

  // ManualPick dialog state
  const [manualPickDialogOpen, setManualPickDialogOpen] = useState(false);
  const [selectedCtfJob, setSelectedCtfJob] = useState<string>('');
  const [selectedAutopickJob, setSelectedAutopickJob] = useState<string>('');

  // Particle picker dialog state
  const [particlePickerOpen, setParticlePickerOpen] = useState(false);

  // Toast notification state
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'warning' | 'info';
  }>({ open: false, message: '', severity: 'info' });

  const showNotification = (message: string, severity: 'success' | 'error' | 'warning' | 'info' = 'info') => {
    setSnackbar({ open: true, message, severity });
  };

  const handleCloseSnackbar = () => {
    setSnackbar(prev => ({ ...prev, open: false }));
  };

  const drawerWidth = 260;

  const loadPipeline = async () => {
    setLoading(true);
    try {
      const pipelineData = await api.getPipeline();
      setPipeline(pipelineData);

      // Restore currentProject from pipeline data on first load
      if (!projectRestoredRef.current && (pipelineData as any).path) {
        projectRestoredRef.current = true;
        setCurrentProject({
          name: (pipelineData as any).name || '',
          path: (pipelineData as any).path,
        });
      }

      // Use processes from pipeline response if available (avoids a second slow API call),
      // fall back to separate getProcesses() endpoint for runtime status enrichment
      const inlineProcesses = (pipelineData as any).processes;
      if (inlineProcesses && inlineProcesses.length > 0) {
        setProcesses(inlineProcesses);
      } else {
        const processesData = await api.getProcesses();
        setProcesses(processesData);
      }
    } catch (error) {
      console.error('Failed to load pipeline:', error);
    } finally {
      setLoading(false);
    }
  };

  // Initial load (runs once). WebSocket support was removed because OOD's
  // reverse proxy doesn't forward upgrade requests; under OOD the helper
  // returned a no-op mock and live updates always came from the polling
  // effect below. Additionally, SocketProvider is now wired up in App.tsx,
  // so we subscribe to live pipeline_update / process_status_change events
  // and refresh the pipeline immediately when the backend pushes one.
  useEffect(() => {
    loadPipeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live push updates from backend SocketIO — refresh the pipeline immediately.
  const handlePipelineUpdate = useCallback(() => {
    loadPipeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useSocketEvent('pipeline_update', handlePipelineUpdate);
  useSocketEvent('process_status_change', handlePipelineUpdate);

  // Adaptive polling: 5s when jobs are active, 30s when idle
  useEffect(() => {
    const hasActiveJobs = processes.some(
      (p) => p.status === ProcessStatus.RUNNING || p.status === ProcessStatus.SCHEDULED
    );
    const pollInterval = hasActiveJobs ? 5000 : 30000;

    const interval = setInterval(() => {
      loadPipeline();
    }, pollInterval);

    return () => {
      clearInterval(interval);
    };
  }, [processes]);

  const handleProcessClick = useCallback((processId: string) => {
    const process = processes.find((p) => p.id === processId);
    if (process) {
      setSelectedProcess(process);
    }
  }, [processes]);

  const handleNewJobClick = useCallback(() => {
    setNewJobDialogOpen(true);
  }, []);

  const handleJobTypeSelect = async (jobType: JobType): Promise<Job | null> => {
    try {
      const template = await api.getJobTemplate(jobType);
      return template;
    } catch (error) {
      console.error('Failed to load job template:', error);
      return null;
    }
  };

  const handleManualPickSelect = () => {
    setSelectedCtfJob('');
    setSelectedAutopickJob('');
    setManualPickDialogOpen(true);
  };

  const handleLaunchParticlePicker = () => {
    // Open the particle picker dialog instead of a new tab
    setManualPickDialogOpen(false);
    setParticlePickerOpen(true);
  };

  // Get available CtfFind and AutoPick jobs from processes
  const ctfJobs = processes.filter(p => p.type === 'CtfFind' && p.status === ProcessStatus.FINISHED_SUCCESS);
  const autopickJobs = processes.filter(p => p.type === 'AutoPick' && p.status === ProcessStatus.FINISHED_SUCCESS);

  const handleJobSubmit = async (job: Job, mode: 'new' | 'continue') => {
    try {
      await api.submitJob(job, mode);
      showNotification(`Job ${job.type} submitted successfully`, 'success');
      loadPipeline();
    } catch (error: unknown) {
      console.error('Failed to submit job:', error);
      const axiosError = error as { response?: { data?: { error?: string } }; message?: string };
      const errorMsg = axiosError?.response?.data?.error || axiosError?.message || 'Unknown error';
      showNotification(`Failed to submit job: ${errorMsg}`, 'error');
      throw error; // Re-throw so NewJobDialog knows it failed
    }
  };

  const handleJobSchedule = async (job: Job) => {
    try {
      await api.scheduleJob(job);
      showNotification(`Job ${job.type} scheduled successfully`, 'success');
      loadPipeline();
    } catch (error: unknown) {
      console.error('Failed to schedule job:', error);
      const axiosError = error as { response?: { data?: { error?: string } }; message?: string };
      const errorMsg = axiosError?.response?.data?.error || axiosError?.message || 'Unknown error';
      showNotification(`Failed to schedule job: ${errorMsg}`, 'error');
      throw error; // Re-throw so NewJobDialog knows it failed
    }
  };

  const handleProcessAbort = async (processId: string): Promise<void> => {
    const process = processes.find(p => p.id === processId);
    setConfirmAction({ type: 'abort', processId, processName: process?.alias || process?.name || processId });
  };

  const handleProcessDelete = async (processId: string): Promise<void> => {
    const process = processes.find(p => p.id === processId);
    setConfirmAction({ type: 'delete', processId, processName: process?.alias || process?.name || processId });
  };

  const handleProcessCleanup = async (processId: string): Promise<void> => {
    const process = processes.find(p => p.id === processId);
    setConfirmAction({ type: 'cleanup', processId, processName: process?.alias || process?.name || processId });
  };

  const handleConfirmAction = async () => {
    if (!confirmAction) return;
    try {
      if (confirmAction.type === 'abort') {
        await api.abortProcess(confirmAction.processId);
      } else if (confirmAction.type === 'delete') {
        await api.deleteProcess(confirmAction.processId);
        setSelectedProcess(null);
      } else if (confirmAction.type === 'cleanup') {
        await api.cleanupProcess(confirmAction.processId);
      }
      loadPipeline();
    } catch (error) {
      console.error(`Failed to ${confirmAction.type} process:`, error);
    }
    setConfirmAction(null);
  };

  const handleRunAgain = async (processId: string) => {
    try {
      const result = await api.runJobAgain(processId);
      console.log('Job re-submitted:', result.message);
      setSelectedProcess(null);
      loadPipeline();
    } catch (error) {
      console.error('Failed to re-run job:', error);
    }
  };

  // Use imported helpers for status counts and filtering (memoized)
  const statusCounts = useMemo(() => getStatusCounts(processes), [processes]);
  const { running: runningCount, scheduled: scheduledCount, completed: completedCount, failed: failedCount } = statusCounts;
  const filteredProcesses = useMemo(
    () => filterProcessesByStatus(processes, statusFilter),
    [processes, statusFilter]
  );

  const handleFilterClick = useCallback((filter: StatusFilter) => {
    setStatusFilter(filter);
    updateActiveView('jobs');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleProjectSelect = async (project: Project) => {
    setCurrentProject(project);
    // Navigate to overview immediately — keep showing previous data until new data loads
    // (clearing processes here would flash "0 jobs" while the pipeline loads)
    updateActiveView('overview');
    // Update backend with selected project, then reload pipeline data
    try {
      const apiBase = getApiBaseUrl();
      await fetch(`${apiBase}/projects/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: project.name, path: project.path }),
      });
      // loadPipeline() overwrites both pipeline and processes with new project data
      await loadPipeline();
    } catch (error) {
      console.error('Failed to select project:', error);
    }
  };

  const handleProjectCreate = async (name: string) => {
    const apiBase = getApiBaseUrl();
    const response = await fetch(`${apiBase}/projects/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Failed to create project');
    }
    const data = await response.json();
    // Backend returns {path, success}. Auto-select the new project so the
    // dashboard switches to it AND the project picker re-fetches its list.
    if (data.path) {
      handleProjectSelect({ name, path: data.path });
    }
  };

  // Stat card config
  const statCards = [
    {
      label: 'Total Jobs',
      value: processes.length,
      icon: <Science />,
      onClick: () => handleFilterClick('all'),
      lightGradient: 'linear-gradient(135deg, #DBEAFE 0%, #BFDBFE 100%)',
      darkGlass: 'rgba(79,70,229,0.08)',
      pillBg: isDarkMode ? 'linear-gradient(135deg, rgba(79,70,229,0.3), rgba(124,58,237,0.2))' : '#1E40AF',
      pillColor: isDarkMode ? '#818CF8' : 'white',
      valueColor: isDarkMode ? '#818CF8' : '#1E40AF',
    },
    {
      label: 'Running',
      value: runningCount,
      icon: <PlayArrow />,
      onClick: () => handleFilterClick('running'),
      lightGradient: 'linear-gradient(135deg, #CFFAFE 0%, #A5F3FC 100%)',
      darkGlass: 'rgba(34,211,238,0.08)',
      pillBg: isDarkMode ? 'rgba(34,211,238,0.15)' : '#0891B2',
      pillColor: isDarkMode ? '#22D3EE' : 'white',
      valueColor: isDarkMode ? '#22D3EE' : '#0E7490',
    },
    {
      label: 'Completed',
      value: completedCount,
      icon: <CheckCircle />,
      onClick: () => handleFilterClick('completed'),
      lightGradient: 'linear-gradient(135deg, #D1FAE5 0%, #A7F3D0 100%)',
      darkGlass: 'rgba(52,211,153,0.08)',
      pillBg: isDarkMode ? 'rgba(52,211,153,0.15)' : '#10B981',
      pillColor: isDarkMode ? '#34D399' : 'white',
      valueColor: isDarkMode ? '#34D399' : '#065F46',
    },
    {
      label: 'Failed',
      value: failedCount,
      icon: <ErrorIcon />,
      onClick: () => handleFilterClick('failed'),
      lightGradient: failedCount > 0
        ? 'linear-gradient(135deg, #FFE4E6 0%, #FECDD3 100%)'
        : 'linear-gradient(135deg, #F1F5F9 0%, #E2E8F0 100%)',
      darkGlass: failedCount > 0 ? 'rgba(244,63,94,0.08)' : 'rgba(148,163,184,0.04)',
      pillBg: failedCount > 0
        ? (isDarkMode ? 'rgba(244,63,94,0.15)' : '#F43F5E')
        : (isDarkMode ? 'rgba(148,163,184,0.1)' : 'grey.400'),
      pillColor: failedCount > 0
        ? (isDarkMode ? '#F43F5E' : 'white')
        : (isDarkMode ? '#9CA3AF' : 'white'),
      valueColor: failedCount > 0
        ? (isDarkMode ? '#F43F5E' : '#9F1239')
        : (isDarkMode ? '#9CA3AF' : 'grey.500'),
    },
  ];

  return (
    <Box sx={{ display: 'flex', height: '100vh', bgcolor: 'background.default' }}>
      {/* Header */}
      <DashboardHeader
        loading={loading}
        drawerOpen={drawerOpen}
        onDrawerToggle={() => setDrawerOpen(!drawerOpen)}
        onRefresh={loadPipeline}
        runningCount={runningCount}
        scheduledCount={scheduledCount}
        completedCount={completedCount}
        failedCount={failedCount}
      />

      {/* Sidebar */}
      <ProjectSidebar
        open={drawerOpen}
        drawerWidth={drawerWidth}
        activeView={activeView}
        onViewChange={updateActiveView}
        onNewJobClick={handleNewJobClick}
        currentProject={currentProject}
        statusFilter={statusFilter}
        onFilterClick={handleFilterClick}
        totalJobs={processes.length}
        runningCount={runningCount}
        completedCount={completedCount}
        failedCount={failedCount}
      />

      {/* Main Content */}
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          p: 3,
          mt: 8,
          ml: drawerOpen ? 0 : `-${drawerWidth}px`,
          transition: (theme) =>
            theme.transitions.create('margin', {
              easing: theme.transitions.easing.sharp,
              duration: theme.transitions.duration.leavingScreen,
            }),
        }}
      >
        {activeView === 'overview' && (
          <Box>
            {!currentProject ? (
              <Box sx={{ textAlign: 'center', py: 12 }}>
                <Typography variant="h5" sx={{ mb: 1 }}>Welcome to RELION 5</Typography>
                <Typography color="text.secondary" sx={{ mb: 3 }}>
                  Select or create a project to get started.
                </Typography>
                <Button variant="contained" onClick={() => updateActiveView('projects')}>
                  Open Projects
                </Button>
              </Box>
            ) : (
            <>
            <Typography variant="h5" fontWeight="bold" mb={3}>
              Project Overview
            </Typography>

            {/* Stats Cards */}
            <Grid container spacing={3} mb={4}>
              {statCards.map((card) => (
                <Grid size={{ xs: 12, sm: 6, md: 3 }} key={card.label}>
                  <Paper
                    elevation={0}
                    onClick={card.onClick}
                    sx={{
                      p: 3,
                      borderRadius: 3,
                      border: '1px solid',
                      borderColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'divider',
                      background: isDarkMode ? card.darkGlass : card.lightGradient,
                      backdropFilter: isDarkMode ? 'blur(20px) saturate(180%)' : undefined,
                      WebkitBackdropFilter: isDarkMode ? 'blur(20px) saturate(180%)' : undefined,
                      boxShadow: isDarkMode ? 'inset 0 1px 0 rgba(255,255,255,0.06)' : undefined,
                      cursor: 'pointer',
                      transition: 'all 250ms cubic-bezier(0.4,0,0.2,1)',
                      position: 'relative',
                      overflow: 'hidden',
                      '&::before': {
                        content: '""',
                        position: 'absolute',
                        inset: 0,
                        background: isDarkMode
                          ? 'linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.06) 50%, transparent 60%)'
                          : 'transparent',
                        backgroundSize: '200% 100%',
                        opacity: 0,
                        transition: 'opacity 300ms ease',
                        pointerEvents: 'none',
                      },
                      '&:hover': {
                        transform: 'translateY(-6px)',
                        boxShadow: isDarkMode
                          ? '0 0 0 1px rgba(99,102,241,0.4), 0 20px 40px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1)'
                          : '0 8px 30px rgba(0,0,0,0.12)',
                        borderColor: isDarkMode ? 'rgba(99,102,241,0.4)' : undefined,
                        '&::before': {
                          opacity: 1,
                          animation: 'shimmer 0.6s ease forwards',
                          backgroundPosition: '200% center',
                        },
                      },
                    }}
                  >
                    <Box display="flex" alignItems="center" gap={2}>
                      <Box sx={{
                        p: 1.5,
                        borderRadius: 2,
                        bgcolor: card.pillBg,
                        color: card.pillColor,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}>
                        {card.icon}
                      </Box>
                      <Box>
                        <Typography variant="h4" fontWeight="bold" color={card.valueColor} sx={{ animation: 'counter-up 0.4s ease forwards' }}>
                          {card.value}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {card.label}
                        </Typography>
                      </Box>
                    </Box>
                  </Paper>
                </Grid>
              ))}
            </Grid>

            {/* Recent Jobs */}
            <Paper
              elevation={0}
              sx={{
                p: 3,
                borderRadius: 3,
                border: '1px solid',
                borderColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'divider',
                mb: 3,
                bgcolor: isDarkMode ? 'rgba(13,21,38,0.7)' : undefined,
                backdropFilter: isDarkMode ? 'blur(20px) saturate(180%)' : undefined,
                WebkitBackdropFilter: isDarkMode ? 'blur(20px) saturate(180%)' : undefined,
                boxShadow: isDarkMode ? 'inset 0 1px 0 rgba(255,255,255,0.06)' : undefined,
              }}
            >
              <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                <Typography variant="h6" fontWeight="bold">
                  Recent Jobs
                </Typography>
                <Button
                  size="small"
                  onClick={() => updateActiveView('jobs')}
                  endIcon={<ChevronRight />}
                >
                  View All
                </Button>
              </Box>

              {processes.length === 0 ? (
                <Box textAlign="center" py={4}>
                  <Science sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
                  <Typography color="text.secondary">
                    No jobs yet. Create your first job to get started.
                  </Typography>
                  <Button
                    variant="contained"
                    startIcon={<Add />}
                    onClick={handleNewJobClick}
                    sx={{ mt: 2 }}
                  >
                    Create Job
                  </Button>
                </Box>
              ) : (
                <Box display="flex" flexDirection="column" gap={1}>
                  {processes.slice(0, 5).map((process) => {
                    const statusInfo = getStatusInfo(process.status);
                    return (
                      <Box
                        key={process.id}
                        sx={{
                          p: 2,
                          borderRadius: 2,
                          border: '1px solid',
                          borderColor: 'transparent',
                          bgcolor: isDarkMode ? 'rgba(255,255,255,0.03)' : 'grey.50',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          cursor: 'pointer',
                          transition: 'all 200ms ease',
                          '&:hover': {
                            bgcolor: isDarkMode ? 'rgba(99,102,241,0.08)' : 'grey.100',
                            borderColor: isDarkMode ? 'rgba(99,102,241,0.25)' : 'transparent',
                          },
                        }}
                        onClick={() => {
                          setSelectedProcess(process);
                          updateActiveView('pipeline');
                        }}
                      >
                        <Box display="flex" alignItems="center" gap={2}>
                          <Box sx={{ color: isDarkMode ? statusInfo.darkColor : statusInfo.color }}>
                            {statusInfo.icon}
                          </Box>
                          <Box>
                            <Typography fontWeight="medium">
                              {process.alias || process.name}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {process.type} - {process.id}
                            </Typography>
                          </Box>
                        </Box>
                        <Chip
                          label={statusInfo.label}
                          size="small"
                          variant="outlined"
                          sx={{
                            borderColor: isDarkMode ? statusInfo.darkColor : statusInfo.color,
                            color: isDarkMode ? statusInfo.darkColor : statusInfo.color,
                            fontWeight: 'bold',
                            boxShadow: isDarkMode ? `0 0 8px ${statusInfo.darkColor}40` : 'none',
                            ...(process.status === ProcessStatus.RUNNING && {
                              animation: 'pulse 2.5s ease infinite',
                            }),
                          }}
                        />
                      </Box>
                    );
                  })}
                </Box>
              )}
            </Paper>

            {/* Quick Actions */}
            <Paper
              elevation={0}
              sx={{
                p: 3,
                borderRadius: 3,
                border: '1px solid',
                borderColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'divider',
                bgcolor: isDarkMode ? 'rgba(13,21,38,0.7)' : undefined,
                backdropFilter: isDarkMode ? 'blur(20px) saturate(180%)' : undefined,
                WebkitBackdropFilter: isDarkMode ? 'blur(20px) saturate(180%)' : undefined,
                boxShadow: isDarkMode ? 'inset 0 1px 0 rgba(255,255,255,0.06)' : undefined,
              }}
            >
              <Typography variant="h6" fontWeight="bold" mb={2}>
                Quick Actions
              </Typography>
              <Grid container spacing={2}>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <Button
                    variant="outlined"
                    fullWidth
                    startIcon={<Add />}
                    onClick={handleNewJobClick}
                    sx={{ py: 2 }}
                  >
                    New Job
                  </Button>
                </Grid>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <Button
                    variant="outlined"
                    fullWidth
                    startIcon={<AccountTree />}
                    onClick={() => updateActiveView('pipeline')}
                    sx={{ py: 2 }}
                  >
                    View Pipeline
                  </Button>
                </Grid>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <Button
                    variant="outlined"
                    fullWidth
                    startIcon={<Folder />}
                    onClick={() => updateActiveView('files')}
                    sx={{ py: 2 }}
                  >
                    Browse Files
                  </Button>
                </Grid>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <Button
                    variant="outlined"
                    fullWidth
                    startIcon={<Refresh />}
                    onClick={loadPipeline}
                    sx={{ py: 2 }}
                  >
                    Refresh
                  </Button>
                </Grid>
              </Grid>
            </Paper>
            </>
            )}
          </Box>
        )}

        {activeView === 'pipeline' && (
          <Box sx={{ height: 'calc(100vh - 100px)', overflow: 'auto' }}>
            {/* Pipeline Graph View - Full Width */}
            <Paper
              elevation={0}
              sx={{
                height: 'calc(100vh - 150px)',
                minHeight: '500px',
                p: 2,
                mb: 3,
                borderRadius: 3,
                border: '1px solid',
                borderColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'divider',
                bgcolor: isDarkMode ? 'rgba(13,21,38,0.7)' : undefined,
                backdropFilter: isDarkMode ? 'blur(20px) saturate(180%)' : undefined,
                WebkitBackdropFilter: isDarkMode ? 'blur(20px) saturate(180%)' : undefined,
                boxShadow: isDarkMode ? 'inset 0 1px 0 rgba(255,255,255,0.06)' : undefined,
              }}
            >
              <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
                <Typography variant="h6" fontWeight="bold">
                  Pipeline Graph
                </Typography>
                <Box display="flex" alignItems="center" gap={1}>
                  <Typography variant="body2" color="text.secondary">
                    Click on a node to view details • Scroll down for job list
                  </Typography>
                  <Tooltip title="Fullscreen">
                    <IconButton size="small" onClick={() => setGraphFullscreen(true)}>
                      <Fullscreen />
                    </IconButton>
                  </Tooltip>
                </Box>
              </Box>
              <Box sx={{ height: 'calc(100% - 40px)', position: 'relative' }}>
                {loading && processes.length === 0 ? (
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      height: '100%',
                      flexDirection: 'column',
                      gap: 2,
                    }}
                  >
                    <CircularProgress />
                    <Typography variant="body2" color="text.secondary">
                      Loading pipeline...
                    </Typography>
                  </Box>
                ) : (
                  <PipelineGraph
                    processes={processes}
                    onProcessClick={handleProcessClick}
                  />
                )}
              </Box>
            </Paper>

            {/* Job List Below Graph */}
            <Grid container spacing={3}>

            {/* Job List Below Graph */}
            <Grid size={{ xs: 12 }} sx={{ height: 'calc(100% - 420px)', overflow: 'auto' }}>
              <Paper
                elevation={0}
                sx={{
                  minHeight: '100%',
                  p: 3,
                  borderRadius: 3,
                  border: '1px solid',
                  borderColor: isDarkMode ? 'rgba(148,163,184,0.15)' : 'divider',
                  bgcolor: isDarkMode ? 'rgba(30,41,59,0.7)' : undefined,
                  backdropFilter: isDarkMode ? 'blur(12px)' : undefined,
                }}
              >
                <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
                  <Typography variant="h6" fontWeight="bold">
                    Pipeline Jobs by Type
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {processes.length} total jobs
                  </Typography>
                </Box>

                {/* Group jobs by type */}
                {(() => {
                  // Define the order of job types in the pipeline
                  const jobTypeOrder = [
                    'Import', 'MotionCorr', 'CtfFind', 'ManualPick', 'AutoPick',
                    'Extract', 'Class2D', 'ClassSelect', 'InitialModel',
                    'Class3D', 'Refine3D', 'CtfRefine', 'Polish',
                    'MaskCreate', 'PostProcess', 'LocalRes', 'ModelAngelo', 'DynaMight'
                  ];

                  // Group processes by type
                  const groupedProcesses = processes.reduce((acc, process) => {
                    const type = process.type || 'Other';
                    if (!acc[type]) acc[type] = [];
                    acc[type].push(process);
                    return acc;
                  }, {} as Record<string, PipelineProcess[]>);

                  // Sort groups by pipeline order
                  const sortedTypes = Object.keys(groupedProcesses).sort((a, b) => {
                    const indexA = jobTypeOrder.indexOf(a);
                    const indexB = jobTypeOrder.indexOf(b);
                    if (indexA === -1 && indexB === -1) return a.localeCompare(b);
                    if (indexA === -1) return 1;
                    if (indexB === -1) return -1;
                    return indexA - indexB;
                  });

                  if (sortedTypes.length === 0) {
                    return (
                      <Box textAlign="center" py={8}>
                        <Science sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
                        <Typography variant="h6" color="text.secondary">
                          No jobs in pipeline
                        </Typography>
                        <Typography variant="body2" color="text.secondary" mb={3}>
                          Create your first job to get started
                        </Typography>
                        <Button variant="contained" startIcon={<Add />} onClick={handleNewJobClick}>
                          Create Job
                        </Button>
                      </Box>
                    );
                  }

                  return sortedTypes.map((type) => {
                    const jobs = groupedProcesses[type];
                    const runningJobs = jobs.filter(j => j.status === ProcessStatus.RUNNING).length;
                    const completedJobs = jobs.filter(j => j.status === ProcessStatus.FINISHED_SUCCESS).length;
                    const failedJobs = jobs.filter(j => j.status === ProcessStatus.FINISHED_FAILURE).length;

                    return (
                      <Accordion
                        key={type}
                        defaultExpanded={jobs.some(j => j.status === ProcessStatus.RUNNING)}
                        sx={{
                          mb: 1,
                          '&:before': { display: 'none' },
                          borderRadius: 2,
                          border: '1px solid',
                          borderColor: isDarkMode ? 'rgba(148,163,184,0.15)' : 'divider',
                          '&.Mui-expanded': { margin: '0 0 8px 0' },
                        }}
                      >
                        <AccordionSummary
                          expandIcon={<ExpandMore />}
                          sx={{
                            bgcolor: isDarkMode ? 'rgba(148,163,184,0.05)' : 'grey.50',
                            borderRadius: '8px 8px 0 0',
                            '&.Mui-expanded': { minHeight: 48 },
                          }}
                        >
                          <Box display="flex" alignItems="center" gap={2} width="100%">
                            <Typography fontWeight="bold" sx={{ flexGrow: 1 }}>
                              {type}
                            </Typography>
                            <Box display="flex" gap={1}>
                              <Chip
                                label={jobs.length}
                                size="small"
                                sx={{
                                  bgcolor: isDarkMode ? 'rgba(96,165,250,0.2)' : 'primary.light',
                                  color: isDarkMode ? '#93C5FD' : 'white',
                                  fontWeight: 'bold',
                                }}
                              />
                              {runningJobs > 0 && (
                                <Chip
                                  icon={<PlayArrow sx={{ fontSize: 14 }} />}
                                  label={runningJobs}
                                  size="small"
                                  sx={{
                                    bgcolor: isDarkMode ? 'rgba(59,130,246,0.15)' : '#DBEAFE',
                                    color: isDarkMode ? '#60A5FA' : '#3B82F6',
                                  }}
                                />
                              )}
                              {completedJobs > 0 && (
                                <Chip
                                  icon={<CheckCircle sx={{ fontSize: 14 }} />}
                                  label={completedJobs}
                                  size="small"
                                  sx={{
                                    bgcolor: isDarkMode ? 'rgba(16,185,129,0.15)' : '#D1FAE5',
                                    color: isDarkMode ? '#34D399' : '#10B981',
                                  }}
                                />
                              )}
                              {failedJobs > 0 && (
                                <Chip
                                  icon={<ErrorIcon sx={{ fontSize: 14 }} />}
                                  label={failedJobs}
                                  size="small"
                                  sx={{
                                    bgcolor: isDarkMode ? 'rgba(239,68,68,0.15)' : '#FEE2E2',
                                    color: isDarkMode ? '#F87171' : '#EF4444',
                                  }}
                                />
                              )}
                            </Box>
                          </Box>
                        </AccordionSummary>
                        <AccordionDetails sx={{ p: 2 }}>
                          <Box display="flex" flexDirection="column" gap={1}>
                            {jobs.map((process) => {
                              const statusInfo = getStatusInfo(process.status);
                              return (
                                <Box
                                  key={process.id}
                                  sx={{
                                    p: 2,
                                    borderRadius: 2,
                                    bgcolor: selectedProcess?.id === process.id
                                      ? (isDarkMode ? 'rgba(59,130,246,0.15)' : alpha('#1E40AF', 0.1))
                                      : (isDarkMode ? 'rgba(148,163,184,0.05)' : 'grey.50'),
                                    border: selectedProcess?.id === process.id ? '2px solid' : '1px solid',
                                    borderColor: selectedProcess?.id === process.id
                                      ? (isDarkMode ? 'rgba(96,165,250,0.5)' : 'primary.main')
                                      : (isDarkMode ? 'rgba(148,163,184,0.1)' : 'divider'),
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    cursor: 'pointer',
                                    transition: 'all 200ms ease',
                                    '&:hover': {
                                      bgcolor: selectedProcess?.id === process.id
                                        ? (isDarkMode ? 'rgba(59,130,246,0.2)' : alpha('#1E40AF', 0.15))
                                        : (isDarkMode ? 'rgba(148,163,184,0.1)' : 'grey.100'),
                                      transform: 'translateX(4px)',
                                    },
                                  }}
                                  onClick={() => handleProcessClick(process.id)}
                                >
                                  <Box display="flex" alignItems="center" gap={2}>
                                    <Box sx={{ color: isDarkMode ? statusInfo.darkColor : statusInfo.color }}>
                                      {statusInfo.icon}
                                    </Box>
                                    <Box>
                                      <Typography fontWeight="medium">
                                        {process.alias || process.name}
                                      </Typography>
                                      <Typography variant="caption" color="text.secondary">
                                        {process.id}
                                      </Typography>
                                    </Box>
                                  </Box>
                                  <Chip
                                    label={statusInfo.label}
                                    size="small"
                                    sx={{
                                      bgcolor: isDarkMode ? statusInfo.darkBgColor : statusInfo.bgColor,
                                      color: isDarkMode ? statusInfo.darkColor : statusInfo.color,
                                      fontWeight: 'bold',
                                    }}
                                  />
                                </Box>
                              );
                            })}
                          </Box>
                        </AccordionDetails>
                      </Accordion>
                    );
                  });
                })()}
              </Paper>
            </Grid>
          </Grid>

          </Box>
        )}

        {activeView === 'jobs' && (
          <JobGrid
            processes={processes}
            filteredProcesses={filteredProcesses}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            loading={loading}
            onJobClick={setSelectedProcess}
            onNewJobClick={handleNewJobClick}
            counts={{ running: runningCount, completed: completedCount, failed: failedCount }}
          />
        )}

        {activeView === 'projects' && (
          <ProjectManager
            currentProject={currentProject}
            onProjectSelect={handleProjectSelect}
            onProjectCreate={handleProjectCreate}
            onCurrentProjectStale={() => {
              // Backend no longer knows about currentProject (deleted, moved,
              // or was cached from a prior user session). Clear so the
              // "Active" badge doesn't linger on a ghost project.
              setCurrentProject(null);
              projectRestoredRef.current = false;
            }}
          />
        )}

        {activeView === 'files' && (
          <Box sx={{ height: 'calc(100vh - 100px)' }}>
            <FileBrowser />
          </Box>
        )}

      </Box>

      {/* Process Detail Dialog - single instance for all views */}
      <ProcessDetailDialog
        process={selectedProcess}
        open={Boolean(selectedProcess)}
        onClose={() => setSelectedProcess(null)}
        onRefresh={loadPipeline}
        onAbort={handleProcessAbort}
        onDelete={handleProcessDelete}
        onCleanup={handleProcessCleanup}
        onRunAgain={handleRunAgain}
        projectPath={currentProject?.path}
      />

      {/* Fullscreen Graph Dialog */}
      <Dialog
        open={graphFullscreen}
        onClose={() => setGraphFullscreen(false)}
        fullScreen
        disableRestoreFocus
        PaperProps={{
          sx: {
            bgcolor: isDarkMode ? '#0F172A' : '#F8FAFC',
          }
        }}
      >
        <DialogTitle sx={{
          m: 0,
          p: 2,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          bgcolor: isDarkMode ? 'rgba(30,41,59,0.9)' : 'white',
          borderBottom: '1px solid',
          borderColor: isDarkMode ? 'rgba(148,163,184,0.15)' : 'divider',
          backdropFilter: isDarkMode ? 'blur(12px)' : undefined,
        }}>
          <Typography variant="h6" fontWeight="bold">
            Pipeline Graph
          </Typography>
          <Box display="flex" alignItems="center" gap={1}>
            <Typography variant="body2" color="text.secondary">
              Click on a node to view details
            </Typography>
            <IconButton onClick={() => setGraphFullscreen(false)}>
              <FullscreenExit />
            </IconButton>
          </Box>
        </DialogTitle>
        <DialogContent sx={{ p: 2, height: 'calc(100vh - 64px)' }}>
          <Box sx={{
            height: '100%',
            bgcolor: isDarkMode ? 'rgba(30,41,59,0.5)' : 'white',
            borderRadius: 2,
            border: '1px solid',
            borderColor: isDarkMode ? 'rgba(148,163,184,0.15)' : 'divider',
          }}>
            <PipelineGraph
              processes={processes}
              onProcessClick={(processId) => {
                handleProcessClick(processId);
                setGraphFullscreen(false);
              }}
            />
          </Box>
        </DialogContent>
      </Dialog>

      {/* New Job Dialog */}
      <NewJobDialog
        open={newJobDialogOpen}
        onClose={() => setNewJobDialogOpen(false)}
        onJobSubmit={handleJobSubmit}
        onJobSchedule={handleJobSchedule}
        onJobTypeSelect={handleJobTypeSelect}
        onManualPickSelect={handleManualPickSelect}
        projectDir={currentProject?.path}
      />

      {/* ManualPick Dialog - Select input jobs for Particle Picker */}
      <Dialog
        open={manualPickDialogOpen}
        onClose={() => setManualPickDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Launch Particle Picker</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Select the input jobs for manual particle picking. The Particle Picker will open in a new tab.
          </Typography>

          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel>CTF Job (micrographs) *</InputLabel>
            <Select
              value={selectedCtfJob}
              onChange={(e) => setSelectedCtfJob(e.target.value)}
              label="CTF Job (micrographs) *"
            >
              {ctfJobs.length === 0 ? (
                <MenuItem disabled>No completed CtfFind jobs found</MenuItem>
              ) : (
                ctfJobs.map((job) => (
                  <MenuItem key={job.id} value={job.id}>
                    {job.id} {job.alias && `(${job.alias})`}
                  </MenuItem>
                ))
              )}
            </Select>
          </FormControl>

          <FormControl fullWidth>
            <InputLabel>AutoPick Job (optional)</InputLabel>
            <Select
              value={selectedAutopickJob}
              onChange={(e) => setSelectedAutopickJob(e.target.value)}
              label="AutoPick Job (optional)"
            >
              <MenuItem value="">None - start fresh</MenuItem>
              {autopickJobs.map((job) => (
                <MenuItem key={job.id} value={job.id}>
                  {job.id} {job.alias && `(${job.alias})`}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setManualPickDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleLaunchParticlePicker}
            disabled={!selectedCtfJob}
          >
            Open Particle Picker
          </Button>
        </DialogActions>
      </Dialog>

      {/* Particle Picker Dialog */}
      <ParticlePickerDialog
        open={particlePickerOpen}
        onClose={() => setParticlePickerOpen(false)}
        project={currentProject?.path || ''}
        ctfJobId={selectedCtfJob}
        autopickJobId={selectedAutopickJob}
      />

      {/* Confirmation dialog for destructive actions */}
      <Dialog open={!!confirmAction} onClose={() => setConfirmAction(null)}>
        <DialogTitle>Confirm {confirmAction?.type}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to {confirmAction?.type} "{confirmAction?.processName}"? This action cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmAction(null)}>Cancel</Button>
          <Button onClick={handleConfirmAction} color="error" variant="contained">
            Confirm
          </Button>
        </DialogActions>
      </Dialog>

      {/* Toast notifications */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={snackbar.severity === 'error' ? null : 6000}
        onClose={handleCloseSnackbar}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          onClose={handleCloseSnackbar}
          severity={snackbar.severity}
          variant="filled"
          sx={{ width: '100%' }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>

    </Box>
  );
};

export default Dashboard;
