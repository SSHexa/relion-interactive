import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Typography,
  Button,
  Box,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
} from '@mui/material';
import JobConfigForm from '../JobConfigForm';
import { Job, JobType } from '../../types/relion';

// Job types that are intentionally HIDDEN from the New Job picker.
// The underlying templates / parameter handlers / backend submission code
// still exist — they're just not shown in the dropdown so that the SPA
// experience stays focused. Restore by deleting the matching entry.
//
// Tomography pipelines are filtered out for now because the site's
// initial customer base is SPA-focused; tomo will be re-enabled once we
// validate the tomo containers + storage layout end-to-end.
const HIDDEN_JOB_TYPES = new Set<JobType>([
  JobType.TOMO_IMPORT,
  JobType.TOMO_EXCLUDETILTS,
  JobType.TOMO_ALIGNTILTS,
  JobType.TOMO_RECONSTRUCT,
  JobType.TOMO_DENOISE,
  JobType.TOMO_IMPORTPARTICLES,
  JobType.TOMO_SUBTOMO,
  JobType.TOMO_CTFREFINE,
]);

interface NewJobDialogProps {
  open: boolean;
  onClose: () => void;
  onJobSubmit: (job: Job, mode: 'new' | 'continue') => Promise<void>;
  onJobSchedule: (job: Job) => Promise<void>;
  onJobTypeSelect: (jobType: JobType) => Promise<Job | null>;
  onManualPickSelect: () => void;
  projectDir?: string;
}

export const NewJobDialog: React.FC<NewJobDialogProps> = ({
  open,
  onClose,
  onJobSubmit,
  onJobSchedule,
  onJobTypeSelect,
  onManualPickSelect,
  projectDir,
}) => {
  const [selectedJobType, setSelectedJobType] = useState<JobType>(JobType.IMPORT);
  const [jobTemplate, setJobTemplate] = useState<Job | null>(null);

  const handleClose = () => {
    setJobTemplate(null);
    onClose();
  };

  const handleJobTypeSelect = async () => {
    // ManualPick is interactive - show dialog to select input jobs
    if (selectedJobType === JobType.MANUALPICK) {
      handleClose();
      onManualPickSelect();
      return;
    }

    const template = await onJobTypeSelect(selectedJobType);
    if (template) {
      setJobTemplate(template);
    }
  };

  const handleBack = () => {
    setJobTemplate(null);
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="md"
      fullWidth
      disableRestoreFocus
      PaperProps={{
        sx: { borderRadius: 3 }
      }}
    >
      <DialogTitle sx={{ pb: 1 }}>
        <Typography variant="h6" fontWeight="bold">
          {jobTemplate ? `Configure ${jobTemplate.type} Job` : 'Create New Job'}
        </Typography>
      </DialogTitle>
      <DialogContent>
        {!jobTemplate ? (
          <Box sx={{ mt: 2 }}>
            <FormControl fullWidth>
              <InputLabel>Select Job Type</InputLabel>
              <Select
                value={selectedJobType}
                onChange={(e) => setSelectedJobType(e.target.value as JobType)}
                label="Select Job Type"
              >
                {Object.values(JobType)
                  .filter((type) => !HIDDEN_JOB_TYPES.has(type))
                  .map((type) => (
                    <MenuItem key={type} value={type}>
                      {type}
                    </MenuItem>
                  ))}
              </Select>
            </FormControl>
            <Button
              variant="contained"
              fullWidth
              sx={{ mt: 2 }}
              onClick={handleJobTypeSelect}
            >
              Select Job Type
            </Button>
          </Box>
        ) : (
          <JobConfigForm
            job={jobTemplate}
            onSubmit={async (job, mode) => {
              try {
                await onJobSubmit(job, mode);
                handleClose();
              } catch {
                // Dashboard already showed a notification. Keep dialog open so user can retry.
              }
            }}
            onSchedule={async (job) => {
              try {
                await onJobSchedule(job);
                handleClose();
              } catch {
                // Same as above.
              }
            }}
            projectDir={projectDir}
          />
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {jobTemplate && (
          <Button onClick={handleBack}>
            Back
          </Button>
        )}
        <Button onClick={handleClose}>
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default NewJobDialog;
