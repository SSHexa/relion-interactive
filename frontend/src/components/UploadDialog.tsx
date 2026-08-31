import React, { useRef, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  LinearProgress,
  Alert,
} from '@mui/material';
import CloudUpload from '@mui/icons-material/CloudUpload';
import { getAppBasePath } from '../services/api';

// Matches the backend cap (RELION_MAX_UPLOAD_BYTES, default 500 MB). We do a
// client-side check before sending so the user gets a friendly error instead
// of waiting for the server to 413. Keep in sync with the backend default.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

interface UploadDialogProps {
  open: boolean;
  onClose: () => void;
  projectDir: string;
  /** Called with the project-relative path of the uploaded file. */
  onUploaded: (relativePath: string) => void;
}

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const UploadDialog: React.FC<UploadDialogProps> = ({ open, onClose, projectDir, onUploaded }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setProgress(0);
    setError(null);
    setUploading(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleClose = () => {
    if (uploading) return; // don't close mid-upload
    reset();
    onClose();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const f = e.target.files?.[0] || null;
    if (f && f.size > MAX_UPLOAD_BYTES) {
      setFile(null);
      setError(`File is ${formatBytes(f.size)}; max upload size is ${formatBytes(MAX_UPLOAD_BYTES)}. Use scp or OOD Files for larger transfers.`);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    setFile(f);
  };

  const handleUpload = () => {
    if (!file || !projectDir) return;
    setUploading(true);
    setError(null);
    setProgress(0);

    // Use XMLHttpRequest because fetch() does not expose upload progress.
    const xhr = new XMLHttpRequest();
    const base = getAppBasePath();
    const url = `${base}/api/files/upload?project_dir=${encodeURIComponent(projectDir)}`;

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) setProgress(Math.round((evt.loaded / evt.total) * 100));
    };
    xhr.onload = () => {
      setUploading(false);
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && data?.path) {
          onUploaded(data.path);
          reset();
        } else {
          setError(data?.error || `Upload failed (HTTP ${xhr.status})`);
        }
      } catch {
        setError(`Upload failed (HTTP ${xhr.status})`);
      }
    };
    xhr.onerror = () => {
      setUploading(false);
      setError('Network error during upload');
    };

    const fd = new FormData();
    fd.append('file', file);
    xhr.open('POST', url);
    xhr.send(fd);
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Upload File</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Upload a single file from your computer. It will be saved under
            <code> uploads/</code> in the current project, and the form field
            will be filled with its relative path.
          </Typography>

          <Button
            variant="outlined"
            startIcon={<CloudUpload />}
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            {file ? 'Choose a different file' : 'Choose file'}
          </Button>
          <input
            ref={inputRef}
            type="file"
            hidden
            onChange={handleFileChange}
          />

          {file && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              <Typography variant="body2"><strong>{file.name}</strong></Typography>
              <Typography variant="caption" color="text.secondary">
                {formatBytes(file.size)}
              </Typography>
            </Box>
          )}

          {uploading && (
            <Box>
              <LinearProgress variant="determinate" value={progress} />
              <Typography variant="caption" color="text.secondary">
                {progress}% uploaded
              </Typography>
            </Box>
          )}

          {error && <Alert severity="error">{error}</Alert>}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={uploading}>Cancel</Button>
        <Button
          onClick={handleUpload}
          variant="contained"
          disabled={!file || uploading}
          startIcon={<CloudUpload />}
        >
          {uploading ? 'Uploading…' : 'Upload'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default UploadDialog;
