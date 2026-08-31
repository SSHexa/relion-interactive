import React from 'react';
import {
  PlayArrow,
  Schedule,
  CheckCircle,
  Error as ErrorIcon,
  Cancel,
} from '@mui/icons-material';
import { Theme } from '@mui/material';
import { ProcessStatus, PipelineProcess } from '../types/relion';

export interface StatusInfo {
  icon: React.ReactNode;
  color: string;
  label: string;
  bgColor: string;
  darkColor: string;
  darkBgColor: string;
  ariaLabel: string;
}

/**
 * Get status display information for a process status.
 * Optionally accepts a theme to use semantic palette colors.
 */
export function getStatusInfo(status: ProcessStatus, theme?: Theme): StatusInfo {
  switch (status) {
    case ProcessStatus.RUNNING:
      return {
        icon: <PlayArrow />,
        color: '#3B82F6',
        label: 'Running',
        bgColor: 'rgba(59, 130, 246, 0.12)',
        darkColor: theme?.palette.info.main ?? '#22D3EE',
        darkBgColor: 'rgba(34,211,238,0.12)',
        ariaLabel: 'Job is running',
      };
    case ProcessStatus.SCHEDULED:
      return {
        icon: <Schedule />,
        color: '#F59E0B',
        label: 'Scheduled',
        bgColor: 'rgba(245, 158, 11, 0.12)',
        darkColor: theme?.palette.warning.main ?? '#FBBF24',
        darkBgColor: 'rgba(251,191,36,0.12)',
        ariaLabel: 'Job is scheduled',
      };
    case ProcessStatus.FINISHED_SUCCESS:
      return {
        icon: <CheckCircle />,
        color: '#10B981',
        label: 'Completed',
        bgColor: 'rgba(16, 185, 129, 0.12)',
        darkColor: theme?.palette.success.main ?? '#34D399',
        darkBgColor: 'rgba(52,211,153,0.12)',
        ariaLabel: 'Job completed successfully',
      };
    case ProcessStatus.FINISHED_FAILURE:
      return {
        icon: <ErrorIcon />,
        color: '#F43F5E',
        label: 'Failed',
        bgColor: 'rgba(244, 63, 94, 0.12)',
        darkColor: theme?.palette.error.main ?? '#F43F5E',
        darkBgColor: 'rgba(244,63,94,0.12)',
        ariaLabel: 'Job failed',
      };
    case ProcessStatus.FINISHED_ABORTED:
      return {
        icon: <Cancel />,
        color: '#6B7280',
        label: 'Aborted',
        bgColor: 'rgba(107, 114, 128, 0.12)',
        darkColor: '#9CA3AF',
        darkBgColor: 'rgba(107,114,128,0.10)',
        ariaLabel: 'Job is paused',
      };
    default:
      return {
        icon: <Schedule />,
        color: '#6B7280',
        label: 'Unknown',
        bgColor: 'rgba(107, 114, 128, 0.12)',
        darkColor: '#9CA3AF',
        darkBgColor: 'rgba(107,114,128,0.10)',
        ariaLabel: 'Job status: idle',
      };
  }
}

export type StatusFilter = 'all' | 'running' | 'completed' | 'failed';

/**
 * Filter processes by status.
 */
export function filterProcessesByStatus(
  processes: PipelineProcess[],
  filter: StatusFilter
): PipelineProcess[] {
  if (filter === 'all') return processes;
  if (filter === 'running') return processes.filter(p => p.status === ProcessStatus.RUNNING);
  if (filter === 'completed') return processes.filter(p => p.status === ProcessStatus.FINISHED_SUCCESS);
  if (filter === 'failed') return processes.filter(p => p.status === ProcessStatus.FINISHED_FAILURE);
  return processes;
}

/**
 * Get count of processes by status.
 */
export function getStatusCounts(processes: PipelineProcess[]) {
  return {
    running: processes.filter(p => p.status === ProcessStatus.RUNNING).length,
    scheduled: processes.filter(p => p.status === ProcessStatus.SCHEDULED).length,
    completed: processes.filter(p => p.status === ProcessStatus.FINISHED_SUCCESS).length,
    failed: processes.filter(p => p.status === ProcessStatus.FINISHED_FAILURE).length,
    total: processes.length,
  };
}
