import React, { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  IconButton,
  Typography,
  Tabs,
  Tab,
  Tooltip,
} from '@mui/material';
import { Close, ViewInAr, Visibility, FolderOpen, LightMode, DarkMode } from '@mui/icons-material';
import { VisualTab, OutputFilesTab } from './results3d';
import { JobType3D, MRCFileInfo, FSCDataPoint, JobInfo, OutputFile, Results3DSummary } from './results3d/types';
import { getAppBasePath } from '../services/api';
import { useThemeContext } from '../contexts/ThemeContext';

const API_BASE = getAppBasePath();

interface Results3DDialogProps {
  open: boolean;
  onClose: () => void;
  jobId: string;
  jobType: JobType3D;
  jobName?: string;
}

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

const TabPanel: React.FC<TabPanelProps> = ({ children, value, index }) => {
  return (
    <Box
      role="tabpanel"
      hidden={value !== index}
      sx={{ flex: 1, display: value === index ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }}
    >
      {value === index && children}
    </Box>
  );
};

export const Results3DDialog: React.FC<Results3DDialogProps> = ({
  open,
  onClose,
  jobId,
  jobType,
  jobName,
}) => {
  const { isDarkMode, toggleTheme } = useThemeContext();
  const [activeTab, setActiveTab] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Data state
  const [mrcFiles, setMrcFiles] = useState<MRCFileInfo[]>([]);
  const [fscData, setFscData] = useState<FSCDataPoint[]>([]);
  const [jobInfo, setJobInfo] = useState<JobInfo | null>(null);
  const [outputFiles, setOutputFiles] = useState<OutputFile[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/api/jobs/${jobId}/3d-results-summary`);
      if (!response.ok) {
        throw new Error('Failed to fetch results data');
      }

      const data: Results3DSummary = await response.json();
      setMrcFiles(data.mrcFiles || []);
      setFscData(data.fscData || []);
      setJobInfo(data.jobInfo || null);
      setOutputFiles(data.outputFiles || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  // Fetch data when dialog opens
  useEffect(() => {
    if (open && jobId) {
      fetchData();
      setActiveTab(0);
    }
  }, [open, jobId, fetchData]);

  const handleTabChange = (_: React.SyntheticEvent, newValue: number) => {
    setActiveTab(newValue);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={false}
      fullWidth
      disableRestoreFocus
      PaperProps={{
        sx: {
          width: '95vw',
          height: '95vh',
          maxWidth: 'none',
        },
      }}
    >
      {/* Title Bar */}
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          bgcolor: 'primary.main',
          color: 'white',
          py: 1,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ViewInAr />
          <Typography variant="h6">
            {jobName || jobId} - {jobType} Results
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Tooltip title={isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}>
            <IconButton onClick={toggleTheme} sx={{ color: 'white' }}>
              {isDarkMode ? <LightMode /> : <DarkMode />}
            </IconButton>
          </Tooltip>
          <IconButton onClick={onClose} sx={{ color: 'white' }}>
            <Close />
          </IconButton>
        </Box>
      </DialogTitle>

      {/* Tabs */}
      <Box
        sx={{
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100'),
        }}
      >
        <Tabs
          value={activeTab}
          onChange={handleTabChange}
          sx={{
            '& .MuiTab-root': {
              minHeight: 48,
              textTransform: 'none',
            },
          }}
        >
          <Tab
            icon={<Visibility sx={{ fontSize: 18 }} />}
            iconPosition="start"
            label="Visual"
          />
          <Tab
            icon={<FolderOpen sx={{ fontSize: 18 }} />}
            iconPosition="start"
            label="Output files"
          />
        </Tabs>
      </Box>

      {/* Content */}
      <DialogContent sx={{ p: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {error ? (
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              height: '100%',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <Typography color="error">{error}</Typography>
          </Box>
        ) : (
          <>
            <TabPanel value={activeTab} index={0}>
              <VisualTab
                jobId={jobId}
                jobType={jobType}
                jobInfo={jobInfo}
                mrcFiles={mrcFiles}
                fscData={fscData}
                loading={loading}
              />
            </TabPanel>
            <TabPanel value={activeTab} index={1}>
              <OutputFilesTab
                jobId={jobId}
                outputFiles={outputFiles}
                loading={loading}
              />
            </TabPanel>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default Results3DDialog;
