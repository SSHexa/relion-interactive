import React, { createContext, useState, useContext, useMemo, useCallback, ReactNode } from 'react';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';

// ── Design Tokens ────────────────────────────────────────────────────
export const designTokens = {
  light: {
    primary: '#1E40AF',
    secondary: '#3B82F6',
    accent: '#F59E0B',
    background: '#F8FAFC',
    paper: '#FFFFFF',
    border: '#E2E8F0',
    statusRunning: '#3B82F6',
    statusSuccess: '#10B981',
    statusError: '#EF4444',
    statusScheduled: '#F59E0B',
    statusAborted: '#6B7280',
  },
  dark: {
    // Color scale
    primary:         '#6366F1',      // indigo solid
    primaryFrom:     '#4F46E5',      // gradient start
    primaryTo:       '#7C3AED',      // gradient end
    secondary:       '#06B6D4',      // cyan accent
    accent:          '#F59E0B',      // electric amber
    accentWarm:      '#FB923C',      // warm orange

    // Backgrounds — deeper than before
    background:      '#060B14',      // root (was #0F172A)
    surface1:        '#0D1526',      // paper/card
    surface2:        '#111827',      // accordion/secondary

    // Glass
    glass:           'rgba(13,21,38,0.7)',
    paper:           '#0D1526',

    // Borders
    border:          'rgba(255,255,255,0.08)',
    borderGlow:      'rgba(99,102,241,0.4)',

    // Status colors (richer, more vivid)
    statusRunning:   '#22D3EE',      // bright cyan (was #60A5FA)
    statusSuccess:   '#34D399',      // emerald (unchanged)
    statusError:     '#F43F5E',      // vivid rose (was #F87171)
    statusScheduled: '#FBBF24',      // bright amber (unchanged)
    statusAborted:   '#9CA3AF',      // gray (unchanged)

    // Text
    textPrimary:     '#F1F5F9',
    textSecondary:   '#94A3B8',
  },
};

const fontFamily = [
  '"Plus Jakarta Sans"',
  '"Inter"',
  "'Fira Sans'",
  '-apple-system',
  'BlinkMacSystemFont',
  '"Segoe UI"',
  'Roboto',
  '"Helvetica Neue"',
  'Arial',
  'sans-serif',
].join(',');

// ── Light Theme ──────────────────────────────────────────────────────
const lightTheme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: designTokens.light.primary },
    secondary: { main: designTokens.light.secondary },
    background: {
      default: designTokens.light.background,
      paper: designTokens.light.paper,
    },
    divider: designTokens.light.border,
    success: { main: designTokens.light.statusSuccess },
    error: { main: designTokens.light.statusError },
    warning: { main: designTokens.light.statusScheduled },
    info: { main: designTokens.light.statusRunning },
  },
  typography: {
    fontFamily,
    h4: { fontWeight: 700, letterSpacing: '-0.02em' },
    h5: { fontWeight: 700, letterSpacing: '-0.01em' },
    h6: { fontWeight: 600, letterSpacing: '-0.01em' },
    subtitle1: { fontWeight: 500 },
    subtitle2: { fontWeight: 500, letterSpacing: '0.02em' },
    overline: { letterSpacing: '0.08em', fontWeight: 600 },
    button: { fontWeight: 600 },
  },
  shape: { borderRadius: 8 },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          boxShadow: 'none',
          borderRadius: '0.5rem',
          '&:hover': { boxShadow: 'none' },
          '&:focus-visible': { outline: '2px solid', outlineOffset: 2 },
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: { borderRadius: '0.75rem' },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
          '&:focus-visible': { outline: '2px solid', outlineOffset: 2 },
        },
      },
    },
    MuiCardActionArea: {
      styleOverrides: {
        root: {
          '&:focus-visible': { outline: '2px solid', outlineOffset: 2 },
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          '&:focus-visible': { outline: '2px solid', outlineOffset: 2 },
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          '&:focus-visible': { outline: '2px solid', outlineOffset: 2 },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none' },
      },
    },
  },
});

// ── Dark Theme ───────────────────────────────────────────────────────
const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main:  designTokens.dark.primary,    // #6366F1
      light: '#818CF8',
      dark:  '#4F46E5',
    },
    secondary: { main: designTokens.dark.secondary },  // #06B6D4
    background: {
      default: designTokens.dark.background,  // #060B14
      paper:   designTokens.dark.paper,       // #0D1526
    },
    text: {
      primary:   designTokens.dark.textPrimary,    // #F1F5F9
      secondary: designTokens.dark.textSecondary,  // #94A3B8
    },
    divider: designTokens.dark.border,
    success: {
      main:  '#34D399',
      light: '#6EE7B7',
      dark:  '#10B981',
    },
    error: {
      main:  '#F43F5E',   // rose
      light: '#FB7185',
      dark:  '#E11D48',
    },
    warning: { main: '#FBBF24' },
    info:    { main: '#22D3EE' },
  },
  typography: {
    fontFamily,
    h4: { fontWeight: 700, letterSpacing: '-0.02em' },
    h5: { fontWeight: 700, letterSpacing: '-0.01em' },
    h6: { fontWeight: 600, letterSpacing: '-0.01em' },
    subtitle1: { fontWeight: 500 },
    subtitle2: { fontWeight: 500, letterSpacing: '0.02em' },
    overline: { letterSpacing: '0.08em', fontWeight: 600 },
    button: { fontWeight: 600 },
  },
  shape: { borderRadius: 8 },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { backgroundColor: designTokens.dark.background },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: designTokens.dark.paper,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: '1rem',
          backgroundColor: designTokens.dark.glass,
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          border: `1px solid ${designTokens.dark.border}`,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: `rgba(6,11,20,0.95)`,
          borderRight: `1px solid ${designTokens.dark.border}`,
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          boxShadow: '1px 0 0 rgba(255,255,255,0.04)',
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: 'rgba(6,11,20,0.85)',
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          borderBottom: `1px solid rgba(255,255,255,0.06)`,
          boxShadow: '0 1px 0 rgba(255,255,255,0.04)',
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundColor: designTokens.dark.surface1,
          backgroundImage: 'none',
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          border: `1px solid ${designTokens.dark.border}`,
          boxShadow: `0 0 0 1px ${designTokens.dark.borderGlow}, 0 24px 48px rgba(0,0,0,0.5)`,
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          boxShadow: 'none',
          borderRadius: '0.5rem',
          '&:hover': { boxShadow: 'none' },
          '&:focus-visible': { outline: '2px solid', outlineOffset: 2 },
        },
        contained: {
          background: `linear-gradient(135deg, ${designTokens.dark.primaryFrom} 0%, ${designTokens.dark.primaryTo} 100%)`,
          '&:hover': {
            background: 'linear-gradient(135deg, #4338CA 0%, #6D28D9 100%)',
            boxShadow: '0 0 20px rgba(99,102,241,0.4)',
          },
        },
        outlined: {
          borderColor: designTokens.dark.border,
          '&:hover': {
            borderColor: designTokens.dark.primary,
            boxShadow: '0 0 8px rgba(99,102,241,0.2)',
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
          borderRadius: '0.5rem',
          backgroundColor: 'rgba(148,163,184,0.08)',
          '&:focus-visible': { outline: '2px solid', outlineOffset: 2 },
        },
        outlined: {
          borderColor: designTokens.dark.border,
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          '&:focus-visible': { outline: '2px solid', outlineOffset: 2 },
        },
      },
    },
    MuiCardActionArea: {
      styleOverrides: {
        root: {
          '&:focus-visible': { outline: '2px solid', outlineOffset: 2 },
        },
      },
    },
    MuiAccordion: {
      styleOverrides: {
        root: {
          backgroundColor: designTokens.dark.surface2,
          backgroundImage: 'none',
          border: `1px solid ${designTokens.dark.border}`,
          borderRadius: '0.5rem !important',
          '&:before': { display: 'none' },
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: '0.625rem',
          transition: 'all 200ms ease',
          '&:focus-visible': { outline: '2px solid', outlineOffset: 2 },
          '&.Mui-selected': {
            background: 'linear-gradient(135deg, rgba(79,70,229,0.2) 0%, rgba(124,58,237,0.15) 100%)',
            boxShadow: 'inset 0 0 0 1px rgba(99,102,241,0.3)',
            '& .MuiListItemIcon-root': {
              color: '#818CF8',
            },
            '& .MuiListItemText-primary': {
              color: '#C7D2FE',
              fontWeight: 600,
            },
            '&:hover': {
              background: 'linear-gradient(135deg, rgba(79,70,229,0.3) 0%, rgba(124,58,237,0.25) 100%)',
            },
          },
          '&:hover': {
            backgroundColor: 'rgba(255,255,255,0.04)',
          },
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        root: {
          '& .MuiTabs-indicator': {
            background: `linear-gradient(90deg, ${designTokens.dark.primaryFrom}, ${designTokens.dark.primaryTo})`,
            height: 2,
            borderRadius: 1,
          },
        },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: {
          borderRadius: 4,
          backgroundColor: 'rgba(255,255,255,0.08)',
        },
        bar: {
          background: `linear-gradient(90deg, ${designTokens.dark.primaryFrom}, ${designTokens.dark.secondary})`,
          borderRadius: 4,
        },
      },
    },
  },
});

interface ThemeContextType {
  isDarkMode: boolean;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType>({
  isDarkMode: true,
  toggleTheme: () => {},
});

export const useThemeContext = () => useContext(ThemeContext);

interface ThemeContextProviderProps {
  children: ReactNode;
}

export const ThemeContextProvider: React.FC<ThemeContextProviderProps> = ({ children }) => {
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem('relion-theme');
    return saved !== null ? saved === 'dark' : false; // default: light
  });

  const toggleTheme = useCallback(() => {
    setIsDarkMode((prev) => {
      const next = !prev;
      localStorage.setItem('relion-theme', next ? 'dark' : 'light');
      return next;
    });
  }, []);

  const theme = isDarkMode ? darkTheme : lightTheme;

  const contextValue = useMemo(
    () => ({ isDarkMode, toggleTheme }),
    [isDarkMode, toggleTheme]
  );

  return (
    <ThemeContext.Provider value={contextValue}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ThemeContext.Provider>
  );
};

export default ThemeContext;
