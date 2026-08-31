import React from 'react';
import {
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  Badge,
  Menu,
  MenuItem,
  Box,
  Divider,
  LinearProgress,
  Tooltip,
  useTheme,
} from '@mui/material';
import {
  Menu as MenuIcon,
  Refresh,
  Notifications,
  Settings,
  Science,
  PlayArrow,
  Schedule,
  CheckCircle,
  Error as ErrorIcon,
  LightMode,
  DarkMode,
} from '@mui/icons-material';
import { useThemeContext } from '../../contexts/ThemeContext';

interface DashboardHeaderProps {
  loading: boolean;
  drawerOpen: boolean;
  onDrawerToggle: () => void;
  onRefresh: () => void;
  runningCount: number;
  scheduledCount: number;
  completedCount: number;
  failedCount: number;
}

export const DashboardHeader: React.FC<DashboardHeaderProps> = ({
  loading,
  drawerOpen,
  onDrawerToggle,
  onRefresh,
  runningCount,
  scheduledCount,
  completedCount,
  failedCount,
}) => {
  const [notificationAnchor, setNotificationAnchor] = React.useState<null | HTMLElement>(null);
  const { isDarkMode, toggleTheme } = useThemeContext();
  const theme = useTheme();

  return (
    <>
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          zIndex: (theme) => theme.zIndex.drawer + 1,
          background: isDarkMode
            ? 'rgba(6,11,20,0.85)'
            : 'rgba(255,255,255,0.9)',
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          borderBottom: '1px solid',
          borderColor: isDarkMode
            ? 'rgba(255,255,255,0.06)'
            : theme.palette.divider,
          color: isDarkMode ? theme.palette.text.primary : '#1E293B',
        }}
      >
        <Toolbar>
          <IconButton
            color="inherit"
            edge="start"
            onClick={onDrawerToggle}
            sx={{ mr: 2 }}
          >
            <MenuIcon />
          </IconButton>

          {/* Brand */}
          <Box sx={{ display: 'flex', alignItems: 'center', flexGrow: 1 }}>
            <Box
              sx={{
                mr: 1.5,
                p: 0.75,
                borderRadius: 2,
                background: isDarkMode
                  ? 'linear-gradient(135deg, rgba(79,70,229,0.3), rgba(6,182,212,0.2))'
                  : 'rgba(30,64,175,0.08)',
                display: 'flex',
                alignItems: 'center',
                transition: 'box-shadow 300ms ease',
                '&:hover': {
                  boxShadow: isDarkMode
                    ? '0 0 16px rgba(99,102,241,0.5)'
                    : '0 0 12px rgba(30,64,175,0.3)',
                },
              }}
            >
              <Science sx={{ color: isDarkMode ? theme.palette.primary.light : theme.palette.primary.main, fontSize: 22 }} />
            </Box>
            <Typography
              variant="h6"
              component="div"
              sx={{
                fontWeight: 700,
                letterSpacing: '-0.01em',
                background: isDarkMode
                  ? 'linear-gradient(135deg, #4F46E5 0%, #06B6D4 100%)'
                  : 'linear-gradient(135deg, #1E40AF 0%, #3B82F6 100%)',
                backgroundClip: 'text',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              RELION 5
            </Typography>
          </Box>

          {loading && (
            <LinearProgress
              sx={{
                width: 100,
                mr: 2,
                borderRadius: 4,
                height: 3,
                backgroundColor: 'rgba(255,255,255,0.1)',
                '& .MuiLinearProgress-bar': {
                  background: 'linear-gradient(90deg, #4F46E5, #06B6D4)',
                  borderRadius: 4,
                },
              }}
            />
          )}

          <Tooltip title="Refresh">
            <IconButton color="inherit" onClick={onRefresh}>
              <Refresh />
            </IconButton>
          </Tooltip>
          <Tooltip title="Notifications">
            <IconButton
              color="inherit"
              aria-label="Job notifications"
              onClick={(e) => setNotificationAnchor(e.currentTarget)}
            >
              <Badge
                badgeContent={runningCount + scheduledCount}
                sx={{
                  '& .MuiBadge-badge': {
                    background: 'linear-gradient(135deg, #F43F5E, #FB923C)',
                    color: 'white',
                  },
                }}
              >
                <Notifications />
              </Badge>
            </IconButton>
          </Tooltip>
          <Tooltip title={isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}>
            <IconButton color="inherit" onClick={toggleTheme}>
              {isDarkMode ? <LightMode /> : <DarkMode />}
            </IconButton>
          </Tooltip>
          <Tooltip title="Settings">
            <IconButton color="inherit">
              <Settings />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      {/* Notification Menu */}
      <Menu
        anchorEl={notificationAnchor}
        open={Boolean(notificationAnchor)}
        onClose={() => setNotificationAnchor(null)}
        aria-label="Recent job notifications"
        PaperProps={{
          sx: { minWidth: 250, mt: 1 }
        }}
      >
        <Box px={2} py={1}>
          <Typography variant="subtitle2" color="text.secondary">
            Job Status
          </Typography>
        </Box>
        <Divider />
        <MenuItem>
          <PlayArrow sx={{ color: theme.palette.info.main, mr: 1.5 }} />
          <Typography variant="body2">{runningCount} running</Typography>
        </MenuItem>
        <MenuItem>
          <Schedule sx={{ color: theme.palette.warning.main, mr: 1.5 }} />
          <Typography variant="body2">{scheduledCount} scheduled</Typography>
        </MenuItem>
        <MenuItem>
          <CheckCircle sx={{ color: theme.palette.success.main, mr: 1.5 }} />
          <Typography variant="body2">{completedCount} completed</Typography>
        </MenuItem>
        {failedCount > 0 && (
          <MenuItem>
            <ErrorIcon sx={{ color: theme.palette.error.main, mr: 1.5 }} />
            <Typography variant="body2">{failedCount} failed</Typography>
          </MenuItem>
        )}
      </Menu>
    </>
  );
};

export default DashboardHeader;
