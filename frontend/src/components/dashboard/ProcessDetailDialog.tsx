import React from 'react';
import {
  Dialog,
  DialogContent,
} from '@mui/material';
import { PipelineProcess } from '../../types/relion';
import ProcessMonitor from '../ProcessMonitor';

interface ProcessDetailDialogProps {
  process: PipelineProcess | null;
  open: boolean;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onAbort: (processId: string) => Promise<void>;
  onDelete: (processId: string) => Promise<void>;
  onCleanup: (processId: string) => Promise<void>;
  onRunAgain: (processId: string) => Promise<void>;
  projectPath?: string;
}

export const ProcessDetailDialog: React.FC<ProcessDetailDialogProps> = ({
  process,
  open,
  onClose,
  onRefresh,
  onAbort,
  onDelete,
  onCleanup,
  onRunAgain,
  projectPath,
}) => {
  if (!process) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{
        sx: {
          height: '85vh',
          maxHeight: '900px',
          borderRadius: 3,
          overflow: 'hidden',
        },
      }}
    >
      <DialogContent sx={{ p: 0, height: '100%' }}>
        <ProcessMonitor
            process={process}
            onClose={onClose}
            onRefresh={onRefresh}
            onAbort={onAbort}
            onDelete={onDelete}
            onCleanup={onCleanup}
            onRunAgain={onRunAgain}
            projectPath={projectPath}
          />
      </DialogContent>
    </Dialog>
  );
};

export default ProcessDetailDialog;
