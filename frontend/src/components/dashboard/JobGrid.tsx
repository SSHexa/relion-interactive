import React from 'react';
import {
  Box,
  Typography,
  Button,
  Chip,
  Card,
  CardContent,
  CardActionArea,
  Skeleton,
  useTheme,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import {
  Add,
  PlayArrow,
  CheckCircle,
  Error as ErrorIcon,
  Science,
} from '@mui/icons-material';
import { PipelineProcess, ProcessStatus } from '../../types/relion';
import { getStatusInfo, StatusFilter } from '../../utils/statusHelpers';
import { useThemeContext } from '../../contexts/ThemeContext';

interface JobGridProps {
  processes: PipelineProcess[];
  filteredProcesses: PipelineProcess[];
  statusFilter: StatusFilter;
  onStatusFilterChange: (filter: StatusFilter) => void;
  loading: boolean;
  onJobClick: (process: PipelineProcess) => void;
  onNewJobClick: () => void;
  counts: {
    running: number;
    completed: number;
    failed: number;
  };
}

export const JobGrid: React.FC<JobGridProps> = React.memo(({
  processes,
  filteredProcesses,
  statusFilter,
  onStatusFilterChange,
  loading,
  onJobClick,
  onNewJobClick,
  counts,
}) => {
  const { isDarkMode } = useThemeContext();
  const theme = useTheme();

  return (
    <Box>
      {/* Header */}
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Typography variant="h5" fontWeight="bold">
          Job Management
        </Typography>
        <Button
          variant="contained"
          startIcon={<Add />}
          onClick={onNewJobClick}
        >
          New Job
        </Button>
      </Box>

      {/* Status Filter Chips */}
      <Box display="flex" gap={1} mb={3} flexWrap="wrap">
        <Chip
          label={`All (${processes.length})`}
          onClick={() => onStatusFilterChange('all')}
          aria-pressed={statusFilter === 'all'}
          sx={{
            cursor: 'pointer',
            transition: 'all 200ms ease',
            bgcolor: statusFilter === 'all'
              ? theme.palette.primary.main
              : (isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)'),
            color: statusFilter === 'all' ? 'white' : 'text.secondary',
            border: `1px solid ${statusFilter === 'all' ? theme.palette.primary.main : (isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.12)')}`,
            boxShadow: statusFilter === 'all' ? `0 0 12px ${theme.palette.primary.main}59` : 'none',
            '&:hover': {
              borderColor: theme.palette.primary.main,
              bgcolor: statusFilter === 'all'
                ? theme.palette.primary.dark
                : (isDarkMode ? `${theme.palette.primary.main}1A` : `${theme.palette.primary.main}14`),
            },
            '&:focus-visible': { outline: '2px solid', outlineOffset: 2 },
          }}
        />
        <Chip
          icon={<PlayArrow />}
          label={`Running (${counts.running})`}
          onClick={() => onStatusFilterChange('running')}
          aria-pressed={statusFilter === 'running'}
          sx={{
            cursor: 'pointer',
            transition: 'all 200ms ease',
            bgcolor: statusFilter === 'running' ? theme.palette.info.main : `${theme.palette.info.main}14`,
            color: statusFilter === 'running' ? '#0F172A' : theme.palette.info.main,
            border: `1px solid ${statusFilter === 'running' ? theme.palette.info.main : `${theme.palette.info.main}40`}`,
            boxShadow: statusFilter === 'running' ? `0 0 14px ${theme.palette.info.main}80` : 'none',
            '& .MuiChip-icon': { color: 'inherit' },
            '&:focus-visible': { outline: '2px solid', outlineOffset: 2 },
          }}
        />
        <Chip
          icon={<CheckCircle />}
          label={`Completed (${counts.completed})`}
          onClick={() => onStatusFilterChange('completed')}
          aria-pressed={statusFilter === 'completed'}
          sx={{
            cursor: 'pointer',
            transition: 'all 200ms ease',
            bgcolor: statusFilter === 'completed' ? theme.palette.success.main : `${theme.palette.success.main}14`,
            color: statusFilter === 'completed' ? '#0F172A' : theme.palette.success.main,
            border: `1px solid ${statusFilter === 'completed' ? theme.palette.success.main : `${theme.palette.success.main}40`}`,
            boxShadow: statusFilter === 'completed' ? `0 0 14px ${theme.palette.success.main}80` : 'none',
            '& .MuiChip-icon': { color: 'inherit' },
            '&:focus-visible': { outline: '2px solid', outlineOffset: 2 },
          }}
        />
        <Chip
          icon={<ErrorIcon />}
          label={`Failed (${counts.failed})`}
          onClick={() => onStatusFilterChange('failed')}
          aria-pressed={statusFilter === 'failed'}
          sx={{
            cursor: 'pointer',
            transition: 'all 200ms ease',
            bgcolor: statusFilter === 'failed' ? theme.palette.error.main : `${theme.palette.error.main}14`,
            color: statusFilter === 'failed' ? '#0F172A' : theme.palette.error.main,
            border: `1px solid ${statusFilter === 'failed' ? theme.palette.error.main : `${theme.palette.error.main}40`}`,
            boxShadow: statusFilter === 'failed' ? `0 0 14px ${theme.palette.error.main}80` : 'none',
            '& .MuiChip-icon': { color: 'inherit' },
            '&:focus-visible': { outline: '2px solid', outlineOffset: 2 },
          }}
        />
      </Box>

      {/* Job Cards Grid */}
      <Grid container spacing={2}>
        {loading && processes.length === 0 ? (
          [...Array(8)].map((_, index) => (
            <Grid size={{ xs: 12, sm: 6, md: 4, lg: 3 }} key={`skeleton-${index}`}>
              <Card
                elevation={0}
                sx={{
                  border: '1px solid',
                  borderColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'divider',
                  borderRadius: 3,
                  bgcolor: isDarkMode ? 'rgba(13,21,38,0.5)' : undefined,
                }}
              >
                <CardContent>
                  <Box display="flex" justifyContent="space-between" alignItems="flex-start" mb={1}>
                    <Skeleton variant="rounded" width={40} height={40} role="status" aria-label="Loading jobs..." />
                    <Skeleton variant="rounded" width={80} height={24} role="status" aria-label="Loading jobs..." />
                  </Box>
                  <Skeleton variant="text" width="70%" height={32} role="status" aria-label="Loading jobs..." />
                  <Skeleton variant="text" width="40%" height={20} role="status" aria-label="Loading jobs..." />
                  <Skeleton variant="text" width="50%" height={16} sx={{ mt: 1 }} role="status" aria-label="Loading jobs..." />
                </CardContent>
              </Card>
            </Grid>
          ))
        ) : filteredProcesses.map((process) => {
          const statusInfo = getStatusInfo(process.status);
          const isRunning = process.status === ProcessStatus.RUNNING;
          return (
            <Grid size={{ xs: 12, sm: 6, md: 4, lg: 3 }} key={process.id}>
              <Card
                elevation={0}
                sx={{
                  border: '1px solid',
                  borderColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'divider',
                  borderRadius: 3,
                  transition: 'all 250ms cubic-bezier(0.4,0,0.2,1)',
                  bgcolor: isDarkMode ? 'rgba(13,21,38,0.7)' : undefined,
                  backdropFilter: isDarkMode ? 'blur(20px) saturate(180%)' : undefined,
                  WebkitBackdropFilter: isDarkMode ? 'blur(20px) saturate(180%)' : undefined,
                  boxShadow: isDarkMode ? 'inset 0 1px 0 rgba(255,255,255,0.06)' : undefined,
                  // Colored top border by status
                  borderTop: `2px solid ${isDarkMode ? statusInfo.darkColor : statusInfo.color}`,
                  position: 'relative',
                  overflow: 'hidden',
                  '&:hover': {
                    transform: 'translateY(-4px)',
                    boxShadow: isDarkMode
                      ? '0 0 0 1px rgba(99,102,241,0.4), 0 20px 40px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1)'
                      : '0 8px 30px rgba(0,0,0,0.1)',
                    borderColor: isDarkMode ? 'rgba(99,102,241,0.4)' : 'divider',
                    '& .card-gradient-overlay': {
                      opacity: 1,
                    },
                  },
                  '&:focus-visible': { outline: '2px solid', outlineOffset: 2 },
                }}
              >
                {/* Gradient overlay on hover */}
                <Box
                  className="card-gradient-overlay"
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    background: isDarkMode
                      ? 'linear-gradient(135deg, rgba(99,102,241,0.05) 0%, rgba(6,182,212,0.03) 100%)'
                      : 'transparent',
                    opacity: 0,
                    transition: 'opacity 300ms ease',
                    pointerEvents: 'none',
                    zIndex: 0,
                  }}
                />
                <CardActionArea onClick={() => onJobClick(process)} sx={{ position: 'relative', zIndex: 1 }}>
                  <CardContent>
                    <Box display="flex" justifyContent="space-between" alignItems="flex-start" mb={1}>
                      {/* Status icon badge */}
                      <Box
                        sx={{
                          p: 1,
                          borderRadius: 1.5,
                          bgcolor: isDarkMode
                            ? `${statusInfo.darkColor}1A`
                            : statusInfo.bgColor,
                          color: isDarkMode ? statusInfo.darkColor : statusInfo.color,
                          border: isDarkMode ? `1px solid ${statusInfo.darkColor}30` : 'none',
                        }}
                      >
                        {statusInfo.icon}
                      </Box>
                      {/* Status chip: outlined+glow */}
                      <Chip
                        label={statusInfo.label}
                        size="small"
                        variant="outlined"
                        sx={{
                          borderColor: isDarkMode ? statusInfo.darkColor : statusInfo.color,
                          color: isDarkMode ? statusInfo.darkColor : statusInfo.color,
                          fontWeight: 'bold',
                          boxShadow: isDarkMode
                            ? `0 0 8px ${statusInfo.darkColor}40`
                            : 'none',
                          ...(isRunning && isDarkMode && {
                            animation: 'pulse 2.5s ease infinite',
                          }),
                        }}
                      />
                    </Box>
                    <Typography variant="h6" fontWeight="bold" noWrap>
                      {process.alias || process.name}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {process.type}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                      {process.id}
                    </Typography>
                  </CardContent>
                </CardActionArea>
              </Card>
            </Grid>
          );
        })}
      </Grid>

      {/* Empty State */}
      {filteredProcesses.length === 0 && !loading && (
        <Box textAlign="center" py={8}>
          <Science sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
          <Typography variant="h6" color="text.secondary">
            {statusFilter === 'all'
              ? 'No jobs yet'
              : `No ${statusFilter} jobs`}
          </Typography>
          <Typography variant="body2" color="text.secondary" mb={3}>
            {statusFilter === 'all'
              ? 'No jobs yet. Click "New Job" to get started.'
              : `No ${statusFilter} jobs.`}
          </Typography>
          {processes.length === 0 && (
            <Button variant="contained" startIcon={<Add />} onClick={onNewJobClick}>
              Create Job
            </Button>
          )}
          {processes.length > 0 && (
            <Button variant="outlined" onClick={() => onStatusFilterChange('all')}>
              Show All Jobs
            </Button>
          )}
        </Box>
      )}
    </Box>
  );
});

export default JobGrid;
