import React, { useState, useEffect, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  Tabs,
  Tab,
  Chip,
  Button,
  Alert,
  CircularProgress,
  Divider,
  Tooltip,
  LinearProgress,
  IconButton,
} from '@mui/material';
import {
  Refresh,
  Stop,
  Delete,
  CleaningServices,
  Terminal,
  Assessment,
  Info,
  PlayArrow,
  CheckCircle,
  Error as ErrorIcon,
  Schedule,
  Cancel,
  FolderOpen,
  AccessTime,
  Replay,
  Close,
} from '@mui/icons-material';
import { PipelineProcess, ProcessStatus, ProcessLog } from '../types/relion';
import { useThemeContext } from '../contexts/ThemeContext';
import api from '../services/api';
import ResultsViewer from './ResultsViewer';

interface ProcessMonitorProps {
  process: PipelineProcess;
  onClose?: () => void;
  onRefresh?: () => void;
  onAbort?: (processId: string) => void;
  onDelete?: (processId: string) => void;
  onCleanup?: (processId: string) => void;
  onRunAgain?: (processId: string) => void;
  projectPath?: string;
}

const ProcessMonitor: React.FC<ProcessMonitorProps> = ({
  process,
  onClose,
  onRefresh,
  onAbort,
  onDelete,
  onCleanup,
  onRunAgain,
  projectPath,
}) => {
  const { isDarkMode } = useThemeContext();
  const [activeTab, setActiveTab] = useState(0);
  const [log, setLog] = useState<ProcessLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const stdoutEndRef = useRef<HTMLDivElement>(null);
  const stderrEndRef = useRef<HTMLDivElement>(null);

  const loadLog = async () => {
    setLoading(true);
    try {
      const logData = await api.getProcessLog(process.id);
      setLog(logData);
    } catch (error) {
      console.error('Failed to load log:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLog();

    // Auto-refresh for running processes
    if (autoRefresh && process.status === ProcessStatus.RUNNING) {
      intervalRef.current = setInterval(() => {
        loadLog();
      }, 3000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [process.id, process.status, autoRefresh]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (activeTab === 1 && stdoutEndRef.current) {
      stdoutEndRef.current.scrollIntoView({ behavior: 'smooth' });
    } else if (activeTab === 2 && stderrEndRef.current) {
      stderrEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [log, activeTab]);

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setActiveTab(newValue);
  };

  const getStatusIcon = (status: ProcessStatus) => {
    switch (status) {
      case ProcessStatus.RUNNING:
        return <PlayArrow />;
      case ProcessStatus.SCHEDULED:
        return <Schedule />;
      case ProcessStatus.FINISHED_SUCCESS:
        return <CheckCircle />;
      case ProcessStatus.FINISHED_FAILURE:
        return <ErrorIcon />;
      case ProcessStatus.FINISHED_ABORTED:
        return <Cancel />;
      default:
        return <Info />;
    }
  };

  const getStatusLabel = (status: ProcessStatus): string => {
    switch (status) {
      case ProcessStatus.RUNNING:
        return 'Running';
      case ProcessStatus.SCHEDULED:
        return 'Scheduled';
      case ProcessStatus.FINISHED_SUCCESS:
        return 'Completed';
      case ProcessStatus.FINISHED_FAILURE:
        return 'Failed';
      case ProcessStatus.FINISHED_ABORTED:
        return 'Aborted';
      default:
        return 'Unknown';
    }
  };

  const getStatusBgColor = (status: ProcessStatus): string => {
    switch (status) {
      case ProcessStatus.RUNNING:
        return 'linear-gradient(135deg, #312E81 0%, #22D3EE 100%)';   // indigo→cyan
      case ProcessStatus.SCHEDULED:
        return 'linear-gradient(135deg, #78350F 0%, #FBBF24 100%)';
      case ProcessStatus.FINISHED_SUCCESS:
        return 'linear-gradient(135deg, #064E3B 0%, #34D399 100%)';
      case ProcessStatus.FINISHED_FAILURE:
        return 'linear-gradient(135deg, #881337 0%, #F43F5E 100%)';   // rose
      case ProcessStatus.FINISHED_ABORTED:
        return 'linear-gradient(135deg, #374151 0%, #6B7280 100%)';
      default:
        return 'linear-gradient(135deg, #374151 0%, #6B7280 100%)';
    }
  };

  const getLineCount = (content: string | string[] | undefined): number => {
    if (!content) return 0;
    if (Array.isArray(content)) return content.length;
    if (typeof content === 'string' && content.length > 0) {
      return content.split('\n').length;
    }
    return 0;
  };

  const renderLogContent = (lines: string[] | string, ref: React.RefObject<HTMLDivElement | null>) => {
    if (loading && !log) {
      return (
        <Box display="flex" justifyContent="center" alignItems="center" p={4}>
          <CircularProgress />
        </Box>
      );
    }

    const linesArray: string[] = Array.isArray(lines)
      ? lines
      : (typeof lines === 'string' && lines.length > 0)
        ? lines.split('\n')
        : [];

    if (linesArray.length === 0) {
      return (
        <Box p={4} textAlign="center">
          <Terminal sx={{ fontSize: 48, color: 'text.disabled', mb: 2 }} />
          <Typography variant="body2" color="text.secondary">
            No output available
          </Typography>
        </Box>
      );
    }

    return (
      <Box
        sx={{
          fontFamily: "'Fira Code', 'Consolas', monospace",
          fontSize: '0.8rem',
          lineHeight: 1.7,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          p: 2,
          backgroundColor: '#020509',
          color: '#CBD5E1',
          borderRadius: 2,
          border: '1px solid rgba(255,255,255,0.06)',
          maxHeight: '400px',
          overflow: 'auto',
          '&::-webkit-scrollbar': { width: '6px' },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': {
            background: 'rgba(148,163,184,0.2)',
            borderRadius: '3px',
          },
        }}
      >
        {linesArray.map((line, index) => {
          // Syntax-hint line coloring
          const isError   = /error|failed|exception/i.test(line);
          const isWarning = /warn(?:ing)?/i.test(line);
          const isSuccess = /success|completed|done|finished/i.test(line);
          const lineColor = isError ? '#F43F5E' : isWarning ? '#FBBF24' : isSuccess ? '#34D399' : '#CBD5E1';

          return (
            <Box
              key={index}
              component="div"
              sx={{
                display: 'flex',
                color: lineColor,
                animation: 'fade-up 0.15s ease both',
                animationDelay: `${Math.min(index * 3, 150)}ms`,
                '&:hover': { backgroundColor: 'rgba(99,102,241,0.08)' },
              }}
            >
              <Box
                component="span"
                sx={{
                  color: '#1E2D3D',
                  minWidth: '42px',
                  textAlign: 'right',
                  pr: 2,
                  userSelect: 'none',
                  borderRight: '1px solid rgba(255,255,255,0.04)',
                  mr: 2,
                  flexShrink: 0,
                }}
              >
                {index + 1}
              </Box>
              <Box component="span">{line || '\u00A0'}</Box>
            </Box>
          );
        })}
        {/* Blinking cursor */}
        <Box
          component="span"
          sx={{
            display: 'inline-block',
            width: '8px',
            height: '1.1em',
            backgroundColor: '#22D3EE',
            animation: 'blink-cursor 1.2s step-end infinite',
            verticalAlign: 'text-bottom',
            ml: 1,
          }}
        />
        <div ref={ref} />
      </Box>
    );
  };

  const isFinished = [
    ProcessStatus.FINISHED_SUCCESS,
    ProcessStatus.FINISHED_FAILURE,
    ProcessStatus.FINISHED_ABORTED,
  ].includes(process.status);

  return (
    <Paper
      elevation={0}
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        border: onClose ? 'none' : '1px solid',
        borderColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'divider',
        borderRadius: onClose ? 0 : 2,
        overflow: 'hidden',
        bgcolor: isDarkMode ? 'rgba(13,21,38,0.7)' : undefined,
        backdropFilter: isDarkMode ? 'blur(20px) saturate(180%)' : undefined,
        WebkitBackdropFilter: isDarkMode ? 'blur(20px) saturate(180%)' : undefined,
      }}
    >
      {/* Status Header */}
      <Box
        sx={{
          background: getStatusBgColor(process.status),
          color: 'white',
          p: 2,
          position: 'relative',
          '&::before': {
            content: '""',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '1px',
            background: 'rgba(255,255,255,0.2)',
          },
          ...(process.status === ProcessStatus.RUNNING && {
            animation: 'pulse 3s ease infinite',
          }),
        }}
      >
        <Box display="flex" justifyContent="space-between" alignItems="flex-start">
          <Box display="flex" alignItems="center" gap={2} sx={{ py: 0.5 }}>
            {getStatusIcon(process.status)}
            <Box>
              <Typography variant="h6" fontWeight="bold">
                {process.alias || process.name}
              </Typography>
              <Typography variant="body2" sx={{ opacity: 0.95, fontWeight: 500 }}>
                {(process.type || process.id?.split('/')[0])} • {getStatusLabel(process.status)}
              </Typography>
            </Box>
          </Box>
          {process.status === ProcessStatus.RUNNING && (
            <CircularProgress size={24} sx={{ color: 'white', mr: onClose ? 5 : 0 }} />
          )}
        </Box>
        {/* Close button for dialog context */}
        {onClose && (
          <IconButton
            aria-label="close"
            onClick={onClose}
            sx={{
              position: 'absolute',
              top: 12,
              right: 12,
              color: 'white',
              bgcolor: 'rgba(0,0,0,0.2)',
              '&:hover': { bgcolor: 'rgba(0,0,0,0.4)' },
            }}
          >
            <Close />
          </IconButton>
        )}
        {process.status === ProcessStatus.RUNNING && (
          <LinearProgress
            sx={{
              mt: 2,
              backgroundColor: 'rgba(255,255,255,0.3)',
              '& .MuiLinearProgress-bar': {
                backgroundColor: 'white',
              },
            }}
          />
        )}
      </Box>

      {/* Quick Info Cards */}
      <Box sx={{ p: 2, bgcolor: isDarkMode ? 'rgba(6,11,20,0.5)' : 'background.default' }}>
        <Box display="flex" gap={1} flexWrap="wrap" mb={2}>
          <Chip
            icon={<FolderOpen />}
            label={process.id}
            size="small"
            variant="outlined"
            sx={{
              borderColor: isDarkMode ? 'rgba(99,102,241,0.3)' : undefined,
              color: isDarkMode ? '#818CF8' : undefined,
              '& .MuiChip-icon': { color: isDarkMode ? '#818CF8' : undefined },
            }}
          />
          {log?.lastUpdate && !isNaN(new Date(log.lastUpdate).getTime()) && (
            <Chip
              icon={<AccessTime />}
              label={new Date(log.lastUpdate).toLocaleTimeString()}
              size="small"
              variant="outlined"
            />
          )}
        </Box>

        {/* Action Buttons */}
        <Box display="flex" gap={1} flexWrap="wrap">
          <Tooltip title="Refresh logs">
            <Button
              size="small"
              variant="outlined"
              startIcon={<Refresh />}
              onClick={() => {
                loadLog();
                if (onRefresh) onRefresh();
              }}
              disabled={loading}
            >
              Refresh
            </Button>
          </Tooltip>

          {process.status === ProcessStatus.RUNNING && onAbort && (
            <Tooltip title="Stop this job">
              <Button
                size="small"
                variant="outlined"
                color="error"
                startIcon={<Stop />}
                onClick={() => onAbort(process.id)}
              >
                Abort
              </Button>
            </Tooltip>
          )}

          {isFinished && onCleanup && (
            <Tooltip title="Clean intermediate files">
              <Button
                size="small"
                variant="outlined"
                startIcon={<CleaningServices />}
                onClick={() => onCleanup(process.id)}
              >
                Clean
              </Button>
            </Tooltip>
          )}

          {isFinished && onDelete && (
            <Tooltip title="Delete this job">
              <Button
                size="small"
                variant="outlined"
                color="error"
                startIcon={<Delete />}
                onClick={() => onDelete(process.id)}
              >
                Delete
              </Button>
            </Tooltip>
          )}

          {isFinished && onRunAgain && (
            <Tooltip title="Run again with same parameters">
              <Button
                size="small"
                variant="contained"
                color="primary"
                startIcon={<Replay />}
                onClick={() => onRunAgain(process.id)}
              >
                Run Again
              </Button>
            </Tooltip>
          )}

          <Button
            size="small"
            variant={autoRefresh ? 'contained' : 'outlined'}
            onClick={() => setAutoRefresh(!autoRefresh)}
            sx={{ ml: 'auto' }}
          >
            Auto-Refresh {autoRefresh ? 'ON' : 'OFF'}
          </Button>
        </Box>
      </Box>

      <Divider />

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onChange={handleTabChange}
        variant="fullWidth"
        sx={{
          borderBottom: 1,
          borderColor: 'divider',
          '& .MuiTab-root': {
            minHeight: 48,
          },
        }}
      >
        <Tab
          icon={<Assessment />}
          label="Results"
          iconPosition="start"
          sx={{ textTransform: 'none' }}
        />
        <Tab
          icon={<Terminal />}
          label={`Output ${log ? `(${getLineCount(log.stdout)})` : ''}`}
          iconPosition="start"
          sx={{ textTransform: 'none' }}
        />
        <Tab
          icon={<ErrorIcon />}
          label={`Errors ${log ? `(${getLineCount(log.stderr)})` : ''}`}
          iconPosition="start"
          sx={{ textTransform: 'none', color: getLineCount(log?.stderr) > 0 ? 'error.main' : undefined }}
        />
      </Tabs>

      {/* Tab Content */}
      <Box sx={{ flexGrow: 1, overflow: 'auto', p: 2 }}>
        {/* Results Tab */}
        {activeTab === 0 && (
          <ResultsViewer processId={process.id} jobType={process.type} projectPath={projectPath} />
        )}

        {/* STDOUT Tab */}
        {activeTab === 1 && renderLogContent(log?.stdout || [], stdoutEndRef)}

        {/* STDERR Tab */}
        {activeTab === 2 && (
          <>
            {renderLogContent(log?.stderr || [], stderrEndRef)}
            {log && getLineCount(log.stderr) > 0 && process.status === ProcessStatus.FINISHED_FAILURE && (
              <Alert severity="error" sx={{ mt: 2 }}>
                Process failed. Check the error output above for details.
              </Alert>
            )}
          </>
        )}
      </Box>
    </Paper>
  );
};

export default ProcessMonitor;
