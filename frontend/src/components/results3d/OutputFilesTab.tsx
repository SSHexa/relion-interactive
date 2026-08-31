import React, { useMemo } from 'react';
import {
  Box,
  Typography,
  Paper,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  ListItemSecondaryAction,
  IconButton,
  Chip,
  Skeleton,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Tooltip,
} from '@mui/material';
import {
  Download,
  ExpandMore,
  InsertDriveFile,
  DataObject,
  PictureAsPdf,
  ViewInAr,
} from '@mui/icons-material';
import { OutputFile } from './types';
import { getAppBasePath } from '../../services/api';

const API_BASE = getAppBasePath();

interface OutputFilesTabProps {
  jobId: string;
  outputFiles: OutputFile[];
  loading: boolean;
}

const getFileIcon = (type: string) => {
  switch (type) {
    case 'mrc':
      return <ViewInAr sx={{ color: (theme) => theme.palette.mode === 'dark' ? '#60A5FA' : '#2563EB' }} />;
    case 'star':
      return <DataObject sx={{ color: (theme) => theme.palette.mode === 'dark' ? '#34D399' : '#059669' }} />;
    case 'pdf':
      return <PictureAsPdf sx={{ color: (theme) => theme.palette.mode === 'dark' ? '#F87171' : '#DC2626' }} />;
    default:
      return <InsertDriveFile sx={{ color: 'text.secondary' }} />;
  }
};

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const getFileTypeLabel = (type: string): string => {
  switch (type) {
    case 'mrc':
      return 'MRC Files (3D Maps)';
    case 'star':
      return 'STAR Files (Metadata)';
    case 'pdf':
      return 'PDF Files (Logs/Reports)';
    default:
      return 'Other Files';
  }
};

const getFileTypeColor = (type: string, isDark: boolean): string => {
  switch (type) {
    case 'mrc':
      return isDark ? '#60A5FA' : '#2563EB';
    case 'star':
      return isDark ? '#34D399' : '#059669';
    case 'pdf':
      return isDark ? '#F87171' : '#DC2626';
    default:
      return isDark ? '#9CA3AF' : '#6B7280';
  }
};

const OutputFilesTab: React.FC<OutputFilesTabProps> = ({ jobId, outputFiles, loading }) => {
  // Group files by type
  const groupedFiles = useMemo(() => {
    const groups: Record<string, OutputFile[]> = {
      mrc: [],
      star: [],
      pdf: [],
      other: [],
    };

    outputFiles.forEach((file) => {
      const type = file.type || 'other';
      if (groups[type]) {
        groups[type].push(file);
      } else {
        groups.other.push(file);
      }
    });

    return groups;
  }, [outputFiles]);

  const handleDownload = (file: OutputFile) => {
    const downloadUrl = `${API_BASE}/api/files/download/${jobId}/${file.name}`;
    window.open(downloadUrl, '_blank');
  };

  if (loading) {
    return (
      <Box sx={{ p: 3 }}>
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} variant="rectangular" height={60} sx={{ mb: 1, borderRadius: 1 }} />
        ))}
      </Box>
    );
  }

  if (outputFiles.length === 0) {
    return (
      <Box
        sx={{
          p: 4,
          textAlign: 'center',
          bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.50'),
          height: '100%',
        }}
      >
        <InsertDriveFile sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
        <Typography variant="h6" color="text.secondary">
          No output files found
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Output files will appear here once the job completes
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        p: 2,
        bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.50'),
        height: '100%',
        overflow: 'auto',
      }}
    >
      {/* Summary */}
      <Paper sx={{ p: 2, mb: 2, bgcolor: 'background.paper' }}>
        <Typography variant="subtitle2" sx={{ mb: 1, color: 'text.secondary' }}>
          Output Summary
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <Chip
            icon={<ViewInAr />}
            label={`${groupedFiles.mrc.length} MRC`}
            sx={(theme) => ({
              bgcolor: theme.palette.mode === 'dark' ? 'rgba(96, 165, 250, 0.15)' : 'rgba(37, 99, 235, 0.1)',
              color: theme.palette.mode === 'dark' ? '#60A5FA' : '#2563EB',
            })}
          />
          <Chip
            icon={<DataObject />}
            label={`${groupedFiles.star.length} STAR`}
            sx={(theme) => ({
              bgcolor: theme.palette.mode === 'dark' ? 'rgba(52, 211, 153, 0.15)' : 'rgba(5, 150, 105, 0.1)',
              color: theme.palette.mode === 'dark' ? '#34D399' : '#059669',
            })}
          />
          <Chip
            icon={<PictureAsPdf />}
            label={`${groupedFiles.pdf.length} PDF`}
            sx={(theme) => ({
              bgcolor: theme.palette.mode === 'dark' ? 'rgba(248, 113, 113, 0.15)' : 'rgba(220, 38, 38, 0.1)',
              color: theme.palette.mode === 'dark' ? '#F87171' : '#DC2626',
            })}
          />
          {groupedFiles.other.length > 0 && (
            <Chip
              icon={<InsertDriveFile />}
              label={`${groupedFiles.other.length} Other`}
              sx={(theme) => ({
                bgcolor: theme.palette.mode === 'dark' ? 'rgba(156, 163, 175, 0.15)' : 'rgba(107, 114, 128, 0.1)',
                color: theme.palette.mode === 'dark' ? '#9CA3AF' : '#6B7280',
              })}
            />
          )}
        </Box>
      </Paper>

      {/* File Groups */}
      {(['mrc', 'star', 'pdf', 'other'] as const).map((type) => {
        const files = groupedFiles[type];
        if (files.length === 0) return null;

        return (
          <Accordion
            key={type}
            defaultExpanded={type === 'mrc'}
            sx={{
              mb: 1,
              bgcolor: 'background.paper',
              '&:before': { display: 'none' },
            }}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {getFileIcon(type)}
                <Typography variant="subtitle2">{getFileTypeLabel(type)}</Typography>
                <Chip
                  label={files.length}
                  size="small"
                  sx={(theme) => ({
                    height: 20,
                    bgcolor: `${getFileTypeColor(type, theme.palette.mode === 'dark')}22`,
                    color: getFileTypeColor(type, theme.palette.mode === 'dark'),
                  })}
                />
              </Box>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <List dense disablePadding>
                {files.map((file, index) => (
                  <ListItem
                    key={file.name}
                    sx={{
                      borderTop: index > 0 ? 1 : 0,
                      borderColor: 'divider',
                      '&:hover': {
                        bgcolor: (theme) =>
                          theme.palette.mode === 'dark'
                            ? 'rgba(255,255,255,0.05)'
                            : 'rgba(0,0,0,0.02)',
                      },
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: 40 }}>{getFileIcon(type)}</ListItemIcon>
                    <ListItemText
                      primary={
                        <Typography
                          variant="body2"
                          sx={{ wordBreak: 'break-all', color: 'text.primary' }}
                        >
                          {file.name}
                        </Typography>
                      }
                      secondary={
                        <Box sx={{ display: 'flex', gap: 1, mt: 0.5 }}>
                          <Typography variant="caption" color="text.secondary">
                            {formatFileSize(file.size)}
                          </Typography>
                          {file.description && (
                            <Typography variant="caption" color="text.secondary">
                              • {file.description}
                            </Typography>
                          )}
                        </Box>
                      }
                    />
                    <ListItemSecondaryAction>
                      <Tooltip title="Download">
                        <IconButton
                          edge="end"
                          size="small"
                          onClick={() => handleDownload(file)}
                          sx={{ color: 'primary.main' }}
                        >
                          <Download />
                        </IconButton>
                      </Tooltip>
                    </ListItemSecondaryAction>
                  </ListItem>
                ))}
              </List>
            </AccordionDetails>
          </Accordion>
        );
      })}
    </Box>
  );
};

export default OutputFilesTab;
