import React, { useState, useEffect } from 'react';
import {
  Box,
  Paper,
  Typography,
  Button,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Card,
  CardContent,
  CardActionArea,
  Chip,
  IconButton,
  Alert,
  CircularProgress,
  Divider,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import {
  Add,
  Folder,
  FolderOpen,
  Delete,
  Refresh,
  Science,
  CheckCircle,
  Storage,
} from '@mui/icons-material';
import { getApiBaseUrl } from '../services/api';
import { useThemeContext } from '../contexts/ThemeContext';

export interface Project {
  name: string;
  path: string;
  created?: string;
  jobCount?: number;
  size?: string;
}

interface ProjectManagerProps {
  currentProject: Project | null;
  onProjectSelect: (project: Project) => void;
  onProjectCreate: (name: string) => Promise<void>;
  /** Signaled when currentProject is no longer in the backend's list
   * (e.g. deleted on disk, or the user's HOME changed). Parent should
   * clear its stored currentProject to avoid a stale "Active" card. */
  onCurrentProjectStale?: () => void;
}

const ProjectManager: React.FC<ProjectManagerProps> = ({
  currentProject,
  onProjectSelect,
  onProjectCreate,
  onCurrentProjectStale,
}) => {
  const { isDarkMode } = useThemeContext();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = async () => {
    setLoading(true);
    setError(null);
    try {
      const apiBase = getApiBaseUrl();
      // Explicit no-cache so browser HTTP cache never serves a stale list
      // (backend already sends Cache-Control: no-store, this is belt+braces).
      const response = await fetch(`${apiBase}/projects`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Failed to load projects');
      const data = await response.json();
      const list = Array.isArray(data) ? data : (data.projects || []);
      setProjects(list);
      // Reconcile: if currentProject is no longer present, tell parent to clear.
      if (
        currentProject &&
        onCurrentProjectStale &&
        !list.some((p: Project) => p.path === currentProject.path)
      ) {
        onCurrentProjectStale();
      }
    } catch (err) {
      console.error('Failed to load projects:', err);
      setError('Failed to load projects. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;

    // Validate project name
    const nameRegex = /^[a-zA-Z0-9_-]+$/;
    if (!nameRegex.test(newProjectName)) {
      setError('Project name can only contain letters, numbers, underscores, and hyphens');
      return;
    }

    setCreating(true);
    setError(null);
    try {
      await onProjectCreate(newProjectName.trim());
      setCreateDialogOpen(false);
      setNewProjectName('');
      loadProjects();
    } catch (err: any) {
      setError(err.message || 'Failed to create project');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteProject = async (projectName: string) => {
    if (!window.confirm(`Are you sure you want to delete project "${projectName}"? This will remove all job data.`)) {
      return;
    }

    try {
      const apiBase = getApiBaseUrl();
      const response = await fetch(`${apiBase}/projects/${projectName}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Failed to delete project');
      loadProjects();
    } catch (err) {
      console.error('Failed to delete project:', err);
      setError('Failed to delete project');
    }
  };

  return (
    <Box>
      {/* Header */}
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Typography variant="h5" fontWeight="bold">
          Projects
        </Typography>
        <Box display="flex" gap={1}>
          <Button
            variant="outlined"
            startIcon={<Refresh />}
            onClick={loadProjects}
            disabled={loading}
          >
            Refresh
          </Button>
          <Button
            variant="contained"
            startIcon={<Add />}
            onClick={() => setCreateDialogOpen(true)}
          >
            New Project
          </Button>
        </Box>
      </Box>

      {/* Current Project Banner */}
      {currentProject && (
        <Paper
          elevation={0}
          sx={{
            p: 2,
            mb: 3,
            borderRadius: 2,
            background: isDarkMode
              ? 'linear-gradient(135deg, rgba(79,70,229,0.15) 0%, rgba(6,182,212,0.08) 100%)'
              : 'linear-gradient(135deg, #DBEAFE 0%, #BFDBFE 100%)',
            border: '1px solid',
            borderColor: isDarkMode ? 'rgba(99,102,241,0.3)' : 'primary.light',
            backdropFilter: isDarkMode ? 'blur(16px) saturate(180%)' : undefined,
            boxShadow: isDarkMode
              ? '0 0 0 1px rgba(99,102,241,0.1), inset 0 1px 0 rgba(255,255,255,0.06)'
              : undefined,
          }}
        >
          <Box display="flex" alignItems="center" gap={2}>
            <FolderOpen color="primary" sx={{ fontSize: 32 }} />
            <Box flexGrow={1}>
              <Typography variant="subtitle2" color="text.secondary">
                Current Project
              </Typography>
              <Typography variant="h6" fontWeight="bold" color="primary.main">
                {currentProject.name}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {currentProject.path}
              </Typography>
            </Box>
            <Chip
              icon={<CheckCircle />}
              label="Active"
              color="primary"
              variant="outlined"
            />
          </Box>
        </Paper>
      )}

      {/* Error Alert */}
      {error && (
        <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {/* Loading State */}
      {loading && (
        <Box display="flex" justifyContent="center" py={4}>
          <CircularProgress />
        </Box>
      )}

      {/* Projects Grid */}
      {!loading && (
        <Grid container spacing={3}>
          {projects.map((project) => (
            <Grid size={{ xs: 12, sm: 6, md: 4 }} key={project.name}>
              <Card
                elevation={0}
                sx={{
                  border: '1px solid',
                  borderColor: currentProject?.name === project.name
                    ? (isDarkMode ? 'rgba(99,102,241,0.5)' : 'primary.main')
                    : (isDarkMode ? 'rgba(255,255,255,0.08)' : 'divider'),
                  borderRadius: 2,
                  transition: 'all 250ms cubic-bezier(0.4,0,0.2,1)',
                  bgcolor: isDarkMode
                    ? (currentProject?.name === project.name ? 'rgba(79,70,229,0.1)' : 'rgba(13,21,38,0.7)')
                    : 'background.paper',
                  backdropFilter: isDarkMode ? 'blur(20px) saturate(180%)' : undefined,
                  WebkitBackdropFilter: isDarkMode ? 'blur(20px) saturate(180%)' : undefined,
                  boxShadow: currentProject?.name === project.name && isDarkMode
                    ? '0 0 0 1px rgba(99,102,241,0.3), 0 0 20px rgba(99,102,241,0.15), inset 0 1px 0 rgba(255,255,255,0.08)'
                    : (isDarkMode ? 'inset 0 1px 0 rgba(255,255,255,0.04)' : undefined),
                  position: 'relative',
                  '&:hover': {
                    boxShadow: isDarkMode
                      ? '0 0 0 1px rgba(99,102,241,0.4), 0 12px 32px rgba(0,0,0,0.4)'
                      : '0 4px 20px rgba(0,0,0,0.08)',
                    transform: 'translateY(-2px)',
                    borderColor: isDarkMode ? 'rgba(99,102,241,0.4)' : undefined,
                  },
                }}
              >
                <CardActionArea onClick={() => onProjectSelect(project)}>
                  <CardContent>
                    <Box display="flex" alignItems="flex-start" gap={2}>
                      <Box
                        sx={{
                          p: 1.5,
                          borderRadius: 2,
                          background: currentProject?.name === project.name
                            ? (isDarkMode
                                ? 'linear-gradient(135deg, #4F46E5, #7C3AED)'
                                : 'primary.main')
                            : (isDarkMode ? 'rgba(255,255,255,0.06)' : 'grey.100'),
                          bgcolor: currentProject?.name === project.name
                            ? undefined
                            : (isDarkMode ? 'rgba(255,255,255,0.06)' : 'grey.100'),
                          color: currentProject?.name === project.name
                            ? 'white'
                            : (isDarkMode ? '#94A3B8' : 'grey.600'),
                          boxShadow: currentProject?.name === project.name && isDarkMode
                            ? '0 0 12px rgba(99,102,241,0.4)'
                            : 'none',
                        }}
                      >
                        <Folder />
                      </Box>
                      <Box flexGrow={1}>
                        <Typography variant="h6" fontWeight="bold" noWrap>
                          {project.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" display="block">
                          {project.path}
                        </Typography>
                        {project.jobCount !== undefined && (
                          <Box display="flex" gap={1} mt={1}>
                            <Chip
                              icon={<Science sx={{ fontSize: 14 }} />}
                              label={`${project.jobCount} jobs`}
                              size="small"
                              sx={{ fontSize: '0.7rem' }}
                            />
                            {project.size && (
                              <Chip
                                icon={<Storage sx={{ fontSize: 14 }} />}
                                label={project.size}
                                size="small"
                                sx={{ fontSize: '0.7rem' }}
                              />
                            )}
                          </Box>
                        )}
                      </Box>
                    </Box>
                    {currentProject?.name === project.name && (
                      <Chip
                        label="Active"
                        size="small"
                        color="primary"
                        sx={{ position: 'absolute', top: 8, right: 8 }}
                      />
                    )}
                  </CardContent>
                </CardActionArea>
                <Divider />
                <Box display="flex" justifyContent="flex-end" p={1}>
                  <IconButton
                    size="small"
                    color="error"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteProject(project.name);
                    }}
                    disabled={currentProject?.name === project.name}
                  >
                    <Delete fontSize="small" />
                  </IconButton>
                </Box>
              </Card>
            </Grid>
          ))}

          {/* Empty State */}
          {projects.length === 0 && !loading && (
            <Grid size={{ xs: 12 }}>
              <Paper
                elevation={0}
                sx={{
                  p: 6,
                  textAlign: 'center',
                  border: '2px dashed',
                  borderColor: 'divider',
                  borderRadius: 3,
                }}
              >
                <Folder sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
                <Typography variant="h6" color="text.secondary" gutterBottom>
                  No Projects Yet
                </Typography>
                <Typography variant="body2" color="text.secondary" mb={3}>
                  Create your first project to start processing cryo-EM data
                </Typography>
                <Button
                  variant="contained"
                  startIcon={<Add />}
                  onClick={() => setCreateDialogOpen(true)}
                >
                  Create First Project
                </Button>
              </Paper>
            </Grid>
          )}
        </Grid>
      )}

      {/* Create Project Dialog */}
      <Dialog
        open={createDialogOpen}
        onClose={() => {
          setCreateDialogOpen(false);
          setNewProjectName('');
          setError(null);
        }}
        maxWidth="sm"
        fullWidth
        disableRestoreFocus
      >
        <DialogTitle>
          <Box display="flex" alignItems="center" gap={1}>
            <Add color="primary" />
            <Typography variant="h6" fontWeight="bold">
              Create New Project
            </Typography>
          </Box>
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" mb={3}>
            Enter a name for your new RELION project. The project folder will be created in the projects directory.
          </Typography>
          <TextField
            fullWidth
            label="Project Name"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            placeholder="my_project"
            helperText="Use only letters, numbers, underscores, and hyphens"
            disabled={creating}
            autoFocus
            onKeyPress={(e) => {
              if (e.key === 'Enter') {
                handleCreateProject();
              }
            }}
          />
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => {
              setCreateDialogOpen(false);
              setNewProjectName('');
              setError(null);
            }}
            disabled={creating}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleCreateProject}
            disabled={!newProjectName.trim() || creating}
            startIcon={creating ? <CircularProgress size={16} /> : <Add />}
          >
            {creating ? 'Creating...' : 'Create Project'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default ProjectManager;
