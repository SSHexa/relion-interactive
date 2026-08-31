import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Box,
  Button,
  IconButton,
  Typography,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Slider,
  Checkbox,
  Paper,
  CircularProgress,
  Tooltip,
  Divider,
} from '@mui/material';
import {
  Close,
  SelectAll,
  Deselect,
  SwapHoriz,
  Save,
  PlayArrow,
  FilterList,
  LightMode,
  DarkMode,
} from '@mui/icons-material';
import { useThemeContext } from '../contexts/ThemeContext';
import { useClassSelection, ClassRow, SortOption } from '../hooks/useClassSelection';

interface Class2DSelectionDialogProps {
  open: boolean;
  onClose: () => void;
  jobId: string;
  onSave: (outputPath: string) => void;
  onRun: (outputPath: string) => void;
}

export const Class2DSelectionDialog: React.FC<Class2DSelectionDialogProps> = ({
  open,
  onClose,
  jobId,
  onSave,
  onRun,
}) => {
  const { isDarkMode, toggleTheme } = useThemeContext();
  const sel = useClassSelection({
    open,
    jobId,
    kind: 'class2d',
    defaultItemsPerRow: 10,
  });

  const handleSave = async () => {
    const path = await sel.submitSelection();
    if (path !== null) {
      onSave(path);
      onClose();
    }
  };

  const handleRun = async () => {
    const path = await sel.submitSelection();
    if (path !== null) {
      onRun(path);
      onClose();
    }
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
          height: '90vh',
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
        <Typography variant="h6">Select Classes</Typography>
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

      <DialogContent sx={{ p: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Controls Bar */}
        <Box
          sx={{
            p: 2,
            bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100'),
            borderBottom: 1,
            borderColor: 'divider',
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            flexWrap: 'wrap',
          }}
        >
          {/* Sort Control */}
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <InputLabel>Sort</InputLabel>
            <Select
              value={sel.sortBy}
              onChange={(e) => sel.setSortBy(e.target.value as SortOption)}
              label="Sort"
            >
              <MenuItem value="distribution">Class Score</MenuItem>
              <MenuItem value="resolution">Resolution</MenuItem>
              <MenuItem value="particleCount">Particle Count</MenuItem>
              <MenuItem value="classNumber">Class Number</MenuItem>
            </Select>
          </FormControl>

          {/* Filter Slider */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 250 }}>
            <FilterList color="action" />
            <Slider
              value={[sel.filterMin, sel.filterMax]}
              onChange={(_, value) => {
                const [min, max] = value as number[];
                sel.setFilterMin(min);
                sel.setFilterMax(max);
              }}
              min={0}
              max={sel.maxDistribution}
              step={0.1}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${v.toFixed(1)}%`}
              color="primary"
            />
            <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
              {sel.filterMin.toFixed(1)}% - {sel.filterMax.toFixed(1)}%
            </Typography>
          </Box>

          {/* Items per Row */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Items per Row:
            </Typography>
            <Select
              value={sel.itemsPerRow}
              onChange={(e) => sel.setItemsPerRow(e.target.value as number)}
              size="small"
              sx={{ minWidth: 60 }}
            >
              {[5, 8, 10, 12, 15].map((n) => (
                <MenuItem key={n} value={n}>
                  {n}
                </MenuItem>
              ))}
            </Select>
          </Box>

          <Divider orientation="vertical" flexItem />

          {/* Selection Controls */}
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button size="small" variant="outlined" startIcon={<SwapHoriz />} onClick={sel.invertSelection}>
              Invert
            </Button>
            <Button size="small" variant="outlined" startIcon={<SelectAll />} onClick={sel.selectAll}>
              Select all
            </Button>
            <Button size="small" variant="outlined" startIcon={<Deselect />} onClick={sel.deselectAll}>
              Deselect all
            </Button>
          </Box>
        </Box>

        {/* Main Content */}
        <Box sx={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Class Grid */}
          <Box
            sx={{
              flex: 1,
              overflow: 'auto',
              p: 2,
              bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.50'),
            }}
          >
            {sel.loading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
                <CircularProgress />
              </Box>
            ) : sel.error ? (
              <Typography color="error" sx={{ p: 4 }}>
                {sel.error}
              </Typography>
            ) : (
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${sel.itemsPerRow}, 1fr)`,
                  gap: 1,
                }}
              >
                {sel.displayedClasses.map((cls) => (
                  <ClassCard
                    key={cls.classNumber}
                    classData={cls}
                    selected={sel.selectedClasses.has(cls.classNumber)}
                    onToggle={() => sel.toggleClass(cls.classNumber)}
                  />
                ))}
              </Box>
            )}
          </Box>

          {/* Selection Overview Panel */}
          <Paper
            sx={{
              width: 200,
              p: 2,
              bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100'),
              borderLeft: 1,
              borderColor: 'divider',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              borderRadius: 0,
            }}
          >
            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
              Selection Overview
            </Typography>

            <Box>
              <Typography variant="h5" sx={{ color: 'text.primary' }}>
                {sel.selectedStats.classCount} / {sel.classes.length}
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Selected
              </Typography>
            </Box>

            <Box>
              <Typography variant="h6" sx={{ color: 'success.main' }}>
                {sel.selectedStats.particleCount.toLocaleString()} / {sel.totalParticles.toLocaleString()}
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                ({sel.selectedStats.percentage.toFixed(2)}%) particles
              </Typography>
            </Box>

            <Divider />

            <Box>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Iteration: {sel.iteration}
              </Typography>
            </Box>
            <Box>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Displayed: {sel.displayedClasses.length} classes
              </Typography>
            </Box>
          </Paper>
        </Box>
      </DialogContent>

      <DialogActions
        sx={{
          bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100'),
          px: 3,
          py: 2,
        }}
      >
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          startIcon={sel.saving ? <CircularProgress size={16} /> : <Save />}
          onClick={handleSave}
          disabled={sel.selectedClasses.size === 0 || sel.saving}
        >
          Save
        </Button>
        <Button
          variant="contained"
          color="success"
          startIcon={sel.saving ? <CircularProgress size={16} /> : <PlayArrow />}
          onClick={handleRun}
          disabled={sel.selectedClasses.size === 0 || sel.saving}
        >
          Run
        </Button>
      </DialogActions>
    </Dialog>
  );
};

// ---- Card ----

interface ClassCardProps {
  classData: ClassRow;
  selected: boolean;
  onToggle: () => void;
}

const ClassCard: React.FC<ClassCardProps> = ({ classData, selected, onToggle }) => {
  return (
    <Tooltip
      title={
        <Box>
          <Typography variant="body2">Class {classData.classNumber}</Typography>
          <Typography variant="caption">{classData.particleCount.toLocaleString()} particles</Typography>
        </Box>
      }
    >
      <Box
        onClick={onToggle}
        sx={{
          position: 'relative',
          aspectRatio: '1',
          cursor: 'pointer',
          border: selected ? 2 : 1,
          borderColor: selected ? 'success.main' : 'divider',
          borderRadius: 1,
          overflow: 'hidden',
          bgcolor: 'background.paper',
          '&:hover': {
            borderColor: selected ? 'success.main' : 'grey.400',
          },
        }}
      >
        {/* Class Image */}
        {classData.imageUrl ? (
          <Box
            component="img"
            src={classData.imageUrl}
            alt={`Class ${classData.classNumber}`}
            sx={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
            }}
          />
        ) : (
          <Box
            sx={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'grey.800' : 'grey.200'),
            }}
          >
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              No image
            </Typography>
          </Box>
        )}

        {/* Selection Checkbox */}
        <Checkbox
          checked={selected}
          size="small"
          sx={{
            position: 'absolute',
            top: 2,
            left: 2,
            p: 0.25,
            bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.8)'),
            borderRadius: 0.5,
            '&:hover': {
              bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)'),
            },
          }}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggle}
        />

        {/* Metadata Overlay */}
        <Box
          sx={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            p: 0.5,
            bgcolor: 'rgba(0,0,0,0.7)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          <Typography variant="caption" sx={{ color: 'white', fontWeight: 'bold', fontSize: '0.65rem' }}>
            {classData.distribution.toFixed(2)}%
          </Typography>
          <Typography variant="caption" sx={{ color: 'grey.300', fontSize: '0.6rem' }}>
            {classData.resolution.toFixed(1)} Å
          </Typography>
        </Box>
      </Box>
    </Tooltip>
  );
};

export default Class2DSelectionDialog;
