import React from 'react';
import {
  Box,
  Button,
  Drawer,
  Toolbar,
  Typography,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  ListItemButton,
  Divider,
  Chip,
  Tooltip,
  alpha,
  useTheme,
} from '@mui/material';
import {
  Dashboard as DashboardIcon,
  AccountTree,
  PlayArrow,
  Folder,
  FolderSpecial,
  Add,
} from '@mui/icons-material';
import { Project } from '../ProjectManager';
import { StatusFilter } from '../../utils/statusHelpers';
import { useThemeContext } from '../../contexts/ThemeContext';

type ViewType = 'overview' | 'pipeline' | 'jobs' | 'files' | 'projects';

interface ProjectSidebarProps {
  open: boolean;
  drawerWidth: number;
  activeView: ViewType;
  onViewChange: (view: ViewType) => void;
  onNewJobClick: () => void;
  currentProject: Project | null;
  statusFilter: StatusFilter;
  onFilterClick: (filter: StatusFilter) => void;
  totalJobs: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
}

const menuItems = [
  { icon: <FolderSpecial />, text: 'Projects', view: 'projects' as const },
  { icon: <DashboardIcon />, text: 'Overview', view: 'overview' as const },
  { icon: <AccountTree />, text: 'Pipeline', view: 'pipeline' as const },
  { icon: <PlayArrow />, text: 'Jobs', view: 'jobs' as const },
  { icon: <Folder />, text: 'Files', view: 'files' as const },
];

export const ProjectSidebar: React.FC<ProjectSidebarProps> = ({
  open,
  drawerWidth,
  activeView,
  onViewChange,
  onNewJobClick,
  currentProject,
  statusFilter,
  onFilterClick,
  totalJobs,
  runningCount,
  completedCount,
  failedCount,
}) => {
  const { isDarkMode } = useThemeContext();
  const theme = useTheme();

  return (
    <Drawer
      variant="persistent"
      open={open}
      sx={{
        width: drawerWidth,
        flexShrink: 0,
        '& .MuiDrawer-paper': {
          width: drawerWidth,
          boxSizing: 'border-box',
          borderRight: 'none',
          boxShadow: isDarkMode
            ? '1px 0 0 rgba(255,255,255,0.04)'
            : '2px 0 8px rgba(0,0,0,0.05)',
        },
      }}
    >
      <Toolbar />
      <Box sx={{ overflow: 'auto', p: 2 }}>
        {/* New Job Button */}
        <Button
          fullWidth
          variant="contained"
          startIcon={<Add />}
          onClick={onNewJobClick}
          sx={{
            mb: 3,
            py: 1.5,
            background: isDarkMode
              ? 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)'
              : 'linear-gradient(135deg, #1E40AF 0%, #3B82F6 100%)',
            boxShadow: isDarkMode
              ? '0 4px 12px rgba(79,70,229,0.35), 0 0 0 1px rgba(99,102,241,0.2)'
              : '0 4px 12px rgba(30,64,175,0.3)',
            borderRadius: 2,
            transition: 'all 200ms ease',
            '&:hover': {
              background: isDarkMode
                ? 'linear-gradient(135deg, #4338CA 0%, #6D28D9 100%)'
                : 'linear-gradient(135deg, #1E3A8A 0%, #2563EB 100%)',
              boxShadow: isDarkMode
                ? '0 6px 20px rgba(79,70,229,0.5), 0 0 0 1px rgba(99,102,241,0.3)'
                : '0 6px 16px rgba(30,64,175,0.4)',
              transform: 'translateY(-1px)',
            },
          }}
        >
          New Job
        </Button>

        {/* Navigation */}
        <Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>
          Navigation
        </Typography>
        <List sx={{ mb: 2 }}>
          {menuItems.map((item, index) => (
            <ListItem
              key={item.text}
              disablePadding
              sx={{
                mb: 0.5,
                animation: 'slide-in 0.2s ease both',
                animationDelay: `${index * 40}ms`,
              }}
            >
              <ListItemButton
                selected={activeView === item.view}
                onClick={() => onViewChange(item.view)}
                sx={{
                  borderRadius: 2,
                  transition: 'all 200ms ease',
                  '&.Mui-selected': {
                    background: isDarkMode
                      ? 'linear-gradient(135deg, rgba(79,70,229,0.2) 0%, rgba(124,58,237,0.12) 100%)'
                      : alpha('#1E40AF', 0.1),
                    boxShadow: isDarkMode
                      ? 'inset 0 0 0 1px rgba(99,102,241,0.3)'
                      : 'none',
                    '& .MuiListItemIcon-root': {
                      color: isDarkMode ? theme.palette.primary.light : theme.palette.primary.main,
                    },
                    '&:hover': {
                      background: isDarkMode
                        ? 'linear-gradient(135deg, rgba(79,70,229,0.3) 0%, rgba(124,58,237,0.2) 100%)'
                        : alpha('#1E40AF', 0.15),
                    },
                  },
                  '&:hover': {
                    backgroundColor: isDarkMode
                      ? 'rgba(255,255,255,0.04)'
                      : alpha('#1E40AF', 0.04),
                  },
                }}
              >
                <ListItemIcon sx={{ minWidth: 40 }}>{item.icon}</ListItemIcon>
                <ListItemText primary={item.text} />
              </ListItemButton>
            </ListItem>
          ))}
        </List>

        <Divider sx={{ my: 2 }} />

        {/* Stats Summary */}
        <Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>
          Summary
        </Typography>
        <Box sx={{ mt: 1, px: 1 }}>
          <Box display="flex" justifyContent="space-between" mb={1}>
            <Typography variant="body2" color="text.secondary">
              Total Jobs
            </Typography>
            <Typography variant="body2" fontWeight="bold">
              {totalJobs}
            </Typography>
          </Box>

          {/* Running */}
          <Box
            display="flex"
            justifyContent="space-between"
            mb={1}
            role="button"
            tabIndex={0}
            aria-label="Filter by running jobs"
            sx={{
              cursor: 'pointer',
              borderRadius: 1,
              p: 0.5,
              mx: -0.5,
              transition: 'background 150ms ease',
              '&:hover': { bgcolor: isDarkMode ? 'rgba(255,255,255,0.04)' : 'action.hover' },
            }}
            onClick={() => onFilterClick('running')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFilterClick('running'); } }}
          >
            <Typography variant="body2" color="text.secondary">
              Running
            </Typography>
            <Chip
              label={runningCount}
              size="small"
              sx={{
                bgcolor: statusFilter === 'running'
                  ? theme.palette.info.main
                  : alpha(theme.palette.info.main, 0.12),
                color: statusFilter === 'running' ? '#FFFFFF' : theme.palette.info.main,
                border: statusFilter === 'running' ? 'none' : `1px solid ${alpha(theme.palette.info.main, 0.3)}`,
                boxShadow: statusFilter === 'running' ? `0 0 10px ${alpha(theme.palette.info.main, 0.4)}` : 'none',
                fontWeight: 'bold',
                ...(runningCount > 0 && statusFilter !== 'running' && {
                  animation: 'pulse 2.5s ease infinite',
                }),
              }}
            />
          </Box>

          {/* Completed */}
          <Box
            display="flex"
            justifyContent="space-between"
            mb={1}
            role="button"
            tabIndex={0}
            aria-label="Filter by completed jobs"
            sx={{
              cursor: 'pointer',
              borderRadius: 1,
              p: 0.5,
              mx: -0.5,
              transition: 'background 150ms ease',
              '&:hover': { bgcolor: isDarkMode ? 'rgba(255,255,255,0.04)' : 'action.hover' },
            }}
            onClick={() => onFilterClick('completed')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFilterClick('completed'); } }}
          >
            <Typography variant="body2" color="text.secondary">
              Completed
            </Typography>
            <Chip
              label={completedCount}
              size="small"
              sx={{
                bgcolor: statusFilter === 'completed'
                  ? theme.palette.success.main
                  : alpha(theme.palette.success.main, 0.12),
                color: statusFilter === 'completed' ? '#FFFFFF' : theme.palette.success.main,
                border: statusFilter === 'completed' ? 'none' : `1px solid ${alpha(theme.palette.success.main, 0.3)}`,
                boxShadow: statusFilter === 'completed' ? `0 0 10px ${alpha(theme.palette.success.main, 0.4)}` : 'none',
                fontWeight: 'bold',
              }}
            />
          </Box>

          {/* Failed */}
          {failedCount > 0 && (
            <Box
              display="flex"
              justifyContent="space-between"
              role="button"
              tabIndex={0}
              aria-label="Filter by failed jobs"
              sx={{
                cursor: 'pointer',
                borderRadius: 1,
                p: 0.5,
                mx: -0.5,
                transition: 'background 150ms ease',
                '&:hover': { bgcolor: isDarkMode ? 'rgba(255,255,255,0.04)' : 'action.hover' },
              }}
              onClick={() => onFilterClick('failed')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFilterClick('failed'); } }}
            >
              <Typography variant="body2" color="text.secondary">
                Failed
              </Typography>
              <Chip
                label={failedCount}
                size="small"
                sx={{
                  bgcolor: statusFilter === 'failed'
                    ? theme.palette.error.main
                    : alpha(theme.palette.error.main, 0.12),
                  color: statusFilter === 'failed' ? '#FFFFFF' : theme.palette.error.main,
                  border: statusFilter === 'failed' ? 'none' : `1px solid ${alpha(theme.palette.error.main, 0.3)}`,
                  boxShadow: statusFilter === 'failed' ? `0 0 10px ${alpha(theme.palette.error.main, 0.4)}` : 'none',
                  fontWeight: 'bold',
                }}
              />
            </Box>
          )}
        </Box>

        {/* Current Project Card */}
        <Box
          mt={3}
          p={2}
          borderRadius={2}
          sx={{
            cursor: 'pointer',
            bgcolor: currentProject
              ? (isDarkMode ? 'rgba(79,70,229,0.08)' : alpha('#1E40AF', 0.05))
              : (isDarkMode ? 'rgba(255,255,255,0.03)' : 'grey.50'),
            border: '1px solid',
            borderColor: currentProject
              ? (isDarkMode ? 'rgba(99,102,241,0.25)' : alpha('#1E40AF', 0.15))
              : (isDarkMode ? 'rgba(255,255,255,0.06)' : 'transparent'),
            backdropFilter: isDarkMode ? 'blur(8px)' : undefined,
            transition: 'all 200ms ease',
            '&:hover': {
              bgcolor: currentProject
                ? (isDarkMode ? 'rgba(79,70,229,0.15)' : alpha('#1E40AF', 0.1))
                : (isDarkMode ? 'rgba(255,255,255,0.06)' : 'grey.100'),
              borderColor: isDarkMode ? 'rgba(99,102,241,0.4)' : undefined,
              boxShadow: isDarkMode ? '0 0 12px rgba(99,102,241,0.2)' : undefined,
            },
          }}
          onClick={() => onViewChange('projects')}
        >
          <Typography variant="caption" color="text.secondary" display="block">
            Current Project
          </Typography>
          <Tooltip
            title={currentProject?.name || ''}
            placement="top"
            arrow
            disableHoverListener={!currentProject}
          >
            <Typography
              variant="body2"
              fontWeight="bold"
              sx={{
                color: isDarkMode ? theme.palette.primary.light : 'primary.main',
                // Long underscored names have no natural break points, so force
                // them to wrap across multiple lines instead of overflowing the
                // sidebar and being clipped.
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
                lineHeight: 1.3,
              }}
            >
              {currentProject?.name || 'No project selected'}
            </Typography>
          </Tooltip>
          {currentProject && (
            <Tooltip title={currentProject.path} placement="top" arrow>
              <Typography
                variant="caption"
                color="text.secondary"
                display="block"
                noWrap
                sx={{ mt: 0.25 }}
              >
                {currentProject.path}
              </Typography>
            </Tooltip>
          )}
          {!currentProject && (
            <Typography variant="caption" sx={{ color: isDarkMode ? theme.palette.primary.light : 'primary.main' }}>
              Click to select a project
            </Typography>
          )}
        </Box>
      </Box>
    </Drawer>
  );
};

export default ProjectSidebar;
