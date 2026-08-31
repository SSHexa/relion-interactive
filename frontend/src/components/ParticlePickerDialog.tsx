import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  IconButton,
  Typography,
  CircularProgress,
} from '@mui/material';
import { Close } from '@mui/icons-material';
import { useThemeContext } from '../contexts/ThemeContext';
import { getAppBasePath } from '../services/api';

interface ParticlePickerDialogProps {
  open: boolean;
  onClose: () => void;
  project: string;
  ctfJobId?: string;
  autopickJobId?: string;
  manualpickJobId?: string;
}

export const ParticlePickerDialog: React.FC<ParticlePickerDialogProps> = ({
  open,
  onClose,
  project,
  ctfJobId,
  autopickJobId,
  manualpickJobId,
}) => {
  const { isDarkMode } = useThemeContext();

  // OOD prefix or "." (headless)
  const appBase = getAppBasePath();
  const pickerBasePath = appBase === '.' ? '/particle-picker' : `${appBase}/particle-picker`;
  let pickerUrl = `${pickerBasePath}/#/?project=${encodeURIComponent(project)}`;
  pickerUrl += `&theme=${isDarkMode ? 'dark' : 'light'}`;
  if (ctfJobId) {
    pickerUrl += `&ctf=${encodeURIComponent(ctfJobId)}`;
  }
  if (autopickJobId) {
    pickerUrl += `&autopick=${encodeURIComponent(autopickJobId)}`;
  }
  if (manualpickJobId) {
    pickerUrl += `&manualpick=${encodeURIComponent(manualpickJobId)}`;
  }

  const [loading, setLoading] = React.useState(true);

  // Reset loading state when dialog opens
  React.useEffect(() => {
    if (open) {
      setLoading(true);
    }
  }, [open]);

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
        <Typography variant="h6">Particle Picker</Typography>
        <IconButton onClick={onClose} sx={{ color: 'white' }}>
          <Close />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ p: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {loading && (
          <Box
            sx={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 1,
            }}
          >
            <CircularProgress />
          </Box>
        )}
        <Box
          component="iframe"
          src={pickerUrl}
          onLoad={() => setLoading(false)}
          sx={{
            flex: 1,
            width: '100%',
            height: '100%',
            border: 'none',
            opacity: loading ? 0 : 1,
            transition: 'opacity 0.3s ease',
          }}
          title="Particle Picker"
        />
      </DialogContent>
    </Dialog>
  );
};

export default ParticlePickerDialog;
