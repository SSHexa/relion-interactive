import React, { useState, useEffect } from 'react';
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
  ViewInAr,
  LightMode,
  DarkMode,
} from '@mui/icons-material';
import VolumeViewer3D from './VolumeViewer3D';
import { useThemeContext } from '../contexts/ThemeContext';
import { useClassSelection, ClassRow, SortOption } from '../hooks/useClassSelection';

interface Class3DSelectionDialogProps {
  open: boolean;
  onClose: () => void;
  jobId: string;
  onSave: (outputPath: string) => void;
  onRun: (outputPath: string) => void;
}

export const Class3DSelectionDialog: React.FC<Class3DSelectionDialogProps> = ({
  open,
  onClose,
  jobId,
  onSave,
  onRun,
}) => {
  const { isDarkMode, toggleTheme } = useThemeContext();
  const [viewedClass, setViewedClass] = useState<number | null>(null);

  const sel = useClassSelection({
    open,
    jobId,
    kind: 'class3d',
    defaultItemsPerRow: 4,
    autoViewFirstOnLoad: false, // we manage viewedClass below
    onOpenReset: () => setViewedClass(null),
  });

  // Auto-select first class for viewing on load (matches original 3D behavior)
  useEffect(() => {
    if (sel.firstClassOnLoad !== null && viewedClass === null) {
      setViewedClass(sel.firstClassOnLoad);
    }
  }, [sel.firstClassOnLoad, viewedClass]);

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

  // MRC filename for the 3D volume viewer
  const getMrcFilename = (classNum: number) =>
    `run_it${String(sel.iteration).padStart(3, '0')}_class${String(classNum).padStart(3, '0')}.mrc`;

  const viewedClassData = viewedClass !== null
    ? sel.classes.find((c) => c.classNumber === viewedClass)
    : null;

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
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ViewInAr />
          <Typography variant="h6">Select 3D Classes</Typography>
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
              {[2, 3, 4, 5, 6].map((n) => (
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
          {/* Left Panel: Class Grid + 3D Viewer */}
          <Box
            sx={{
              flex: 1,
              overflow: 'auto',
              p: 2,
              bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.50'),
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
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
              <>
                {/* Class Grid */}
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${sel.itemsPerRow}, 1fr)`,
                    gap: 1.5,
                  }}
                >
                  {sel.displayedClasses.map((cls) => (
                    <Class3DCard
                      key={cls.classNumber}
                      classData={cls}
                      selected={sel.selectedClasses.has(cls.classNumber)}
                      viewed={viewedClass === cls.classNumber}
                      onToggle={() => sel.toggleClass(cls.classNumber)}
                      onView={() => setViewedClass(cls.classNumber)}
                    />
                  ))}
                </Box>

                {/* 3D Volume Viewer */}
                {viewedClass !== null && (
                  <Paper sx={{ p: 2, mt: 2 }}>
                    <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 'bold' }}>
                      <ViewInAr sx={{ mr: 1, verticalAlign: 'middle' }} />
                      3D View - Class {viewedClass}
                    </Typography>
                    <Box sx={{ height: 400 }}>
                      <VolumeViewer3D
                        jobId={jobId}
                        mrcFile={getMrcFilename(viewedClass)}
                        title={`Class ${viewedClass}`}
                      />
                    </Box>
                  </Paper>
                )}
              </>
            )}
          </Box>

          {/* Selection Overview Panel */}
          <Paper
            sx={{
              width: 220,
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
                Classes Selected
              </Typography>
            </Box>

            <Box>
              <Typography variant="h6" sx={{ color: 'success.main' }}>
                {sel.selectedStats.particleCount.toLocaleString()}
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                of {sel.totalParticles.toLocaleString()} particles ({sel.selectedStats.percentage.toFixed(1)}%)
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

            {viewedClass !== null && (
              <>
                <Divider />
                <Box>
                  <Typography variant="caption" sx={{ color: 'primary.main', fontWeight: 'bold' }}>
                    Viewing: Class {viewedClass}
                  </Typography>
                  {viewedClassData && (
                    <>
                      <Typography variant="caption" display="block" sx={{ color: 'text.secondary' }}>
                        {viewedClassData.distribution.toFixed(1)}% particles
                      </Typography>
                      <Typography variant="caption" display="block" sx={{ color: 'text.secondary' }}>
                        {viewedClassData.resolution.toFixed(1)} Å resolution
                      </Typography>
                    </>
                  )}
                </Box>
              </>
            )}
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

// ---- 3D Card ----

interface Class3DCardProps {
  classData: ClassRow;
  selected: boolean;
  viewed: boolean;
  onToggle: () => void;
  onView: () => void;
}

const Class3DCard: React.FC<Class3DCardProps> = ({ classData, selected, viewed, onToggle, onView }) => {
  return (
    <Tooltip
      title={
        <Box>
          <Typography variant="body2">Class {classData.classNumber}</Typography>
          <Typography variant="caption">{classData.particleCount.toLocaleString()} particles</Typography>
          <Typography variant="caption" display="block">
            Click image to view in 3D
          </Typography>
        </Box>
      }
    >
      <Box
        sx={{
          position: 'relative',
          aspectRatio: '1',
          cursor: 'pointer',
          border: viewed ? 3 : selected ? 2 : 1,
          borderColor: viewed ? 'primary.main' : selected ? 'success.main' : 'divider',
          borderRadius: 1,
          overflow: 'hidden',
          bgcolor: 'background.paper',
          boxShadow: viewed ? 3 : 0,
          '&:hover': {
            borderColor: viewed ? 'primary.main' : selected ? 'success.main' : 'grey.400',
          },
        }}
      >
        {/* Class Image (Central Slice) */}
        <Box
          onClick={onView}
          sx={{
            width: '100%',
            height: '100%',
          }}
        >
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
        </Box>

        {/* Selection Checkbox */}
        <Checkbox
          checked={selected}
          size="small"
          sx={{
            position: 'absolute',
            top: 2,
            left: 2,
            p: 0.25,
            bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.9)'),
            borderRadius: 0.5,
            '&:hover': {
              bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'rgba(0,0,0,0.8)' : 'white'),
            },
          }}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggle}
        />

        {/* 3D Indicator */}
        {viewed && (
          <Box
            sx={{
              position: 'absolute',
              top: 2,
              right: 2,
              bgcolor: 'primary.main',
              color: 'white',
              borderRadius: 0.5,
              p: 0.25,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <ViewInAr sx={{ fontSize: 16 }} />
          </Box>
        )}

        {/* Metadata Overlay */}
        <Box
          sx={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            p: 0.75,
            bgcolor: 'rgba(0,0,0,0.75)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          <Typography variant="caption" sx={{ color: 'white', fontWeight: 'bold', fontSize: '0.7rem' }}>
            Class {classData.classNumber} - {classData.distribution.toFixed(1)}%
          </Typography>
          <Typography variant="caption" sx={{ color: 'grey.300', fontSize: '0.65rem' }}>
            {classData.resolution.toFixed(1)} Å • {classData.particleCount.toLocaleString()} ptcls
          </Typography>
        </Box>
      </Box>
    </Tooltip>
  );
};

export default Class3DSelectionDialog;
