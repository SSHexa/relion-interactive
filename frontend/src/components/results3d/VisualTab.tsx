import React, { useState, useMemo } from 'react';
import {
  Box,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Typography,
  Paper,
  Chip,
  Divider,
  Skeleton,
} from '@mui/material';
import { ViewInAr, Speed, Straighten, Grain } from '@mui/icons-material';
import VolumeViewer3D from '../VolumeViewer3D';
import FSCChart from './FSCChart';
import { MRCFileInfo, FSCDataPoint, JobInfo, JobType3D } from './types';

type SortOption = 'distribution' | 'resolution' | 'particleCount';

interface VisualTabProps {
  jobId: string;
  jobType: JobType3D;
  jobInfo: JobInfo | null;
  mrcFiles: MRCFileInfo[];
  fscData: FSCDataPoint[];
  loading: boolean;
}

const VisualTab: React.FC<VisualTabProps> = ({
  jobId,
  jobType,
  jobInfo,
  mrcFiles,
  fscData,
  loading,
}) => {
  const [selectedMrcFile, setSelectedMrcFile] = useState<string>('');
  const [sortBy, setSortBy] = useState<SortOption>('distribution');

  // Auto-select first MRC file
  React.useEffect(() => {
    if (mrcFiles.length > 0 && !selectedMrcFile) {
      setSelectedMrcFile(mrcFiles[0].filename);
    }
  }, [mrcFiles, selectedMrcFile]);

  // Sort MRC files (for Class3D)
  const sortedMrcFiles = useMemo(() => {
    if (jobType !== 'Class3D') return mrcFiles;

    return [...mrcFiles].sort((a, b) => {
      const aVal = a[sortBy] ?? 0;
      const bVal = b[sortBy] ?? 0;
      return bVal - aVal; // Descending
    });
  }, [mrcFiles, sortBy, jobType]);

  // Get selected file info
  const selectedFileInfo = mrcFiles.find((f) => f.filename === selectedMrcFile);

  // Check if FSC data is available
  const hasFscData = fscData.length > 0;
  const showMultipleFscCurves = jobType === 'PostProcess';

  if (loading) {
    return (
      <Box sx={{ p: 3 }}>
        <Skeleton variant="rectangular" height={400} sx={{ mb: 2, borderRadius: 1 }} />
        <Skeleton variant="rectangular" height={300} sx={{ borderRadius: 1 }} />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Main Content */}
      <Box
        sx={{
          flex: 1,
          overflow: 'auto',
          p: 2,
          bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.50'),
        }}
      >
        {/* Controls Bar */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            mb: 2,
            flexWrap: 'wrap',
          }}
        >
          {/* File Selector */}
          <FormControl size="small" sx={{ minWidth: 250 }}>
            <InputLabel>File</InputLabel>
            <Select
              value={selectedMrcFile}
              onChange={(e) => setSelectedMrcFile(e.target.value)}
              label="File"
            >
              {sortedMrcFiles.map((file) => (
                <MenuItem key={file.filename} value={file.filename}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="body2">{file.filename}</Typography>
                    {file.classNumber && (
                      <Chip
                        label={`Class ${file.classNumber}`}
                        size="small"
                        sx={{ height: 20, fontSize: '0.7rem' }}
                      />
                    )}
                    {file.distribution && (
                      <Typography variant="caption" color="text.secondary">
                        ({file.distribution.toFixed(1)}%)
                      </Typography>
                    )}
                  </Box>
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {/* Sort Control (only for Class3D with multiple files) */}
          {jobType === 'Class3D' && mrcFiles.length > 1 && (
            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel>Sort</InputLabel>
              <Select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                label="Sort"
              >
                <MenuItem value="distribution">Class Score</MenuItem>
                <MenuItem value="resolution">Resolution</MenuItem>
                <MenuItem value="particleCount">Particle Count</MenuItem>
              </Select>
            </FormControl>
          )}
        </Box>

        {/* 3D Viewer */}
        {selectedMrcFile && (
          <Paper
            sx={{
              mb: 2,
              overflow: 'hidden',
              bgcolor: 'background.paper',
            }}
          >
            <VolumeViewer3D
              jobId={jobId}
              mrcFile={selectedMrcFile}
              title={`3D View - ${selectedMrcFile}`}
            />
          </Paper>
        )}

        {/* FSC Chart */}
        {hasFscData && (
          <Paper sx={{ p: 2, bgcolor: 'background.paper' }}>
            <FSCChart
              data={fscData}
              finalResolution={jobInfo?.finalResolution}
              title={showMultipleFscCurves ? 'FSC Curves (Masked vs Unmasked)' : 'Gold-Standard FSC'}
              showMultipleCurves={showMultipleFscCurves}
            />
          </Paper>
        )}
      </Box>

      {/* Right Panel - Metadata */}
      <Paper
        sx={{
          width: 280,
          p: 2,
          bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100'),
          borderLeft: 1,
          borderColor: 'divider',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          borderRadius: 0,
          overflow: 'auto',
        }}
      >
        <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
          Job Information
        </Typography>

        {/* Job Type */}
        <Box>
          <Typography variant="caption" color="text.secondary">
            Job Type
          </Typography>
          <Typography variant="body1" fontWeight="bold" color="primary.main">
            {jobType}
          </Typography>
        </Box>

        {/* Resolution */}
        {jobInfo?.finalResolution && (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Speed sx={{ fontSize: 16, color: 'text.secondary' }} />
              <Typography variant="caption" color="text.secondary">
                Final Resolution
              </Typography>
            </Box>
            <Typography variant="h6" sx={{ color: 'success.main', fontWeight: 'bold' }}>
              {jobInfo.finalResolution.toFixed(2)} Å
            </Typography>
          </Box>
        )}

        {/* Voxel Size */}
        {jobInfo?.voxelSize && (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Straighten sx={{ fontSize: 16, color: 'text.secondary' }} />
              <Typography variant="caption" color="text.secondary">
                Voxel Size
              </Typography>
            </Box>
            <Typography variant="body1">{jobInfo.voxelSize.toFixed(3)} Å</Typography>
          </Box>
        )}

        {/* Volume Size */}
        {jobInfo?.volumeSize && (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <ViewInAr sx={{ fontSize: 16, color: 'text.secondary' }} />
              <Typography variant="caption" color="text.secondary">
                Volume Size
              </Typography>
            </Box>
            <Typography variant="body1">{jobInfo.volumeSize.join(' x ')} voxels</Typography>
          </Box>
        )}

        {/* Total Particles */}
        {jobInfo?.totalParticles && (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Grain sx={{ fontSize: 16, color: 'text.secondary' }} />
              <Typography variant="caption" color="text.secondary">
                Total Particles
              </Typography>
            </Box>
            <Typography variant="body1">{jobInfo.totalParticles.toLocaleString()}</Typography>
          </Box>
        )}

        {/* Iteration */}
        {jobInfo?.iteration && (
          <Box>
            <Typography variant="caption" color="text.secondary">
              Iteration
            </Typography>
            <Typography variant="body1">{jobInfo.iteration}</Typography>
          </Box>
        )}

        <Divider />

        {/* Selected File Info */}
        {selectedFileInfo && (
          <>
            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
              Selected File
            </Typography>

            <Box>
              <Typography
                variant="body2"
                sx={{ color: 'primary.main', fontWeight: 'bold', wordBreak: 'break-all' }}
              >
                {selectedFileInfo.filename}
              </Typography>
            </Box>

            {selectedFileInfo.classNumber && (
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Class Number
                </Typography>
                <Typography variant="body1">Class {selectedFileInfo.classNumber}</Typography>
              </Box>
            )}

            {selectedFileInfo.distribution && (
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Distribution (Class Score)
                </Typography>
                <Typography variant="body1" sx={{ color: 'success.main' }}>
                  {selectedFileInfo.distribution.toFixed(1)}%
                </Typography>
              </Box>
            )}

            {selectedFileInfo.resolution && (
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Resolution
                </Typography>
                <Typography variant="body1">{selectedFileInfo.resolution.toFixed(2)} Å</Typography>
              </Box>
            )}

            {selectedFileInfo.particleCount && (
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Particles
                </Typography>
                <Typography variant="body1">
                  {selectedFileInfo.particleCount.toLocaleString()}
                </Typography>
              </Box>
            )}
          </>
        )}

        {/* Number of MRC files */}
        <Divider />
        <Box>
          <Typography variant="caption" color="text.secondary">
            Available Files
          </Typography>
          <Typography variant="body2">{mrcFiles.length} MRC file(s)</Typography>
        </Box>
      </Paper>
    </Box>
  );
};

export default VisualTab;
