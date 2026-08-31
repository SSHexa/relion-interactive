import React, { useState, useEffect } from 'react';
import {
  Box,
  Paper,
  Typography,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  ListItemButton,
  Breadcrumbs,
  Link,
  IconButton,
  TextField,
  InputAdornment,
  Chip,
  Divider,
  Button,
  Checkbox,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from '@mui/material';
import {
  Folder,
  InsertDriveFile,
  Home,
  Search,
  Refresh,
  FolderOpen,
  Description,
  Image as ImageIcon,
  CheckCircle,
  Pattern,
  ArrowBack,
  SelectAll,
  Clear,
  ExpandMore,
} from '@mui/icons-material';
import api, { getApiBaseUrl } from '../services/api';

interface FileItem {
  name: string;
  type: 'file' | 'dir';
  path: string;
}

interface FileBrowserProps {
  onFileSelect?: (filePath: string) => void;
  onMultiFileSelect?: (filePaths: string[]) => void;  // For multi-select mode
  nodeType?: string;
  rootPath?: string;
  selectDirectory?: boolean;  // When true, allow selecting directories instead of navigating into them
  allowPattern?: boolean;  // When true, show pattern input for glob matching
  multiSelect?: boolean;  // When true, allow selecting multiple files
  fileFilter?: string;  // Filter files by extension (e.g., '.tiff', '.mrc')
}

interface GlobResult {
  name: string;
  path: string;
  absolute_path: string;
  type: 'file' | 'dir';
}

const FileBrowser: React.FC<FileBrowserProps> = ({
  onFileSelect,
  onMultiFileSelect,
  nodeType,
  rootPath = '.',
  selectDirectory = false,
  allowPattern = false,
  multiSelect = false,
  fileFilter = ''
}) => {
  const [currentPath, setCurrentPath] = useState<string>(rootPath);
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [nodes, setNodes] = useState<Array<{name: string; path: string; type: string}>>([]);
  const [patternInput, setPatternInput] = useState('');
  const [patternResults, setPatternResults] = useState<GlobResult[]>([]);
  const [patternMode, setPatternMode] = useState(false);
  const [patternCount, setPatternCount] = useState(0);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  // Track if we're currently navigating (to prevent useEffect from resetting)
  const [isNavigating, setIsNavigating] = useState(false);

  // Track the last rootPath to detect when it changes (dialog reopens with new path)
  const [lastRootPath, setLastRootPath] = useState(rootPath);

  // Reset to rootPath ONLY when rootPath actually changes (e.g., when dialog reopens)
  // Don't reset just because isNavigating changed
  useEffect(() => {
    if (rootPath !== lastRootPath) {
      setLastRootPath(rootPath);
      setCurrentPath(rootPath);
    }
  }, [rootPath, lastRootPath]);

  const loadDirectory = async (path: string, isNavigation: boolean = false) => {
    if (isNavigation) {
      setIsNavigating(true);
    }
    setLoading(true);
    try {
      console.log('FileBrowser: Loading directory:', path);
      const dirItems = await api.listDirectory(path);
      console.log('FileBrowser: Got items:', dirItems.length, 'items');
      const fileItems: FileItem[] = dirItems.map((item: { name: string; type: 'file' | 'dir'; path?: string }) => ({
        name: item.name,
        type: item.type,
        // Use path from API response if available (for absolute paths)
        path: item.path || (path === '/' ? `/${item.name}` : `${path}/${item.name}`),
      }));
      setItems(fileItems);
      setCurrentPath(path);
      console.log('FileBrowser: Updated currentPath to:', path);
    } catch (error) {
      console.error('Failed to load directory:', error);
    } finally {
      setLoading(false);
      if (isNavigation) {
        // Reset navigation flag after a short delay to prevent race conditions
        setTimeout(() => setIsNavigating(false), 100);
      }
    }
  };

  const loadNodes = async () => {
    try {
      const nodeList = await api.browseNodes(nodeType);
      setNodes(nodeList);
    } catch (error) {
      console.error('Failed to load nodes:', error);
    }
  };

  const searchPattern = async (pattern: string) => {
    if (!pattern.trim()) {
      setPatternResults([]);
      setPatternMode(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`${getApiBaseUrl()}/files/glob?pattern=${encodeURIComponent(pattern)}`);
      const data = await response.json();
      if (data.files) {
        setPatternResults(data.files);
        setPatternCount(data.count);
        setPatternMode(true);
      }
    } catch (error) {
      console.error('Failed to search pattern:', error);
    } finally {
      setLoading(false);
    }
  };

  const handlePatternSelect = () => {
    if (patternInput && onFileSelect) {
      // User wants to use the pattern as-is (e.g., "Movies/*.tiff")
      onFileSelect(patternInput);
    }
  };

  // Multi-select helpers
  const toggleFileSelection = (filePath: string) => {
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      if (newSet.has(filePath)) {
        newSet.delete(filePath);
      } else {
        newSet.add(filePath);
      }
      return newSet;
    });
  };

  const selectAllFiles = () => {
    const files = filteredItems
      .filter(item => item.type === 'file')
      .filter(item => !fileFilter || item.name.toLowerCase().endsWith(fileFilter.toLowerCase()))
      .map(item => item.path);
    setSelectedFiles(new Set(files));
  };

  const clearSelection = () => {
    setSelectedFiles(new Set());
  };

  const confirmMultiSelection = () => {
    if (onMultiFileSelect && selectedFiles.size > 0) {
      onMultiFileSelect(Array.from(selectedFiles));
    }
  };

  // Get filtered items based on fileFilter
  const getFilteredFiles = () => {
    return filteredItems.filter(item => {
      if (item.type === 'dir') return true;
      if (!fileFilter) return true;
      return item.name.toLowerCase().endsWith(fileFilter.toLowerCase());
    });
  };

  useEffect(() => {
    // Only load directory if not currently navigating (navigation already loads)
    if (!isNavigating) {
      loadDirectory(currentPath);
    }
    if (nodeType) {
      loadNodes();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, nodeType]);

  const handleItemClick = (item: FileItem) => {
    console.log('FileBrowser: Item clicked:', item.name, 'type:', item.type, 'path:', item.path);
    if (item.type === 'dir') {
      // Navigate into the directory
      loadDirectory(item.path, true);  // Pass true to indicate user navigation
    } else {
      // Select files (unless we're in directory-only mode)
      if (onFileSelect && !selectDirectory) {
        onFileSelect(item.path);
      }
    }
  };

  const handleItemDoubleClick = (item: FileItem) => {
    // Double-click on directory to select it (when in selectDirectory mode)
    if (item.type === 'dir' && selectDirectory && onFileSelect) {
      // Add trailing slash to indicate it's a directory
      const dirPath = item.path.endsWith('/') ? item.path : item.path + '/';
      onFileSelect(dirPath);
    }
  };

  const handleBreadcrumbClick = (index: number) => {
    const pathParts = currentPath.split('/').filter(p => p !== '');
    const newPath = '/' + pathParts.slice(0, index + 1).join('/');
    loadDirectory(newPath || '/', true);  // Pass true to indicate user navigation
  };

  const getFileIcon = (item: FileItem) => {
    if (item.type === 'dir') {
      return <Folder color="primary" />;
    }

    const ext = item.name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'star':
        return <Description color="info" />;
      case 'mrc':
      case 'mrcs':
      case 'tif':
      case 'tiff':
      case 'png':
      case 'jpg':
      case 'jpeg':
        return <ImageIcon color="success" />;
      default:
        return <InsertDriveFile />;
    }
  };

  const getFileTypeLabel = (fileName: string): string | null => {
    const ext = fileName.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'star':
        return 'STAR';
      case 'mrc':
      case 'mrcs':
        return 'MRC';
      case 'tif':
      case 'tiff':
        return 'TIFF';
      default:
        return null;
    }
  };

  const filteredItems = items.filter((item) =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const pathParts = currentPath.split('/').filter((p) => p !== '' && p !== '.');

  return (
    <Paper elevation={2} sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <Box p={2}>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
          <Typography variant="h6">File Browser</Typography>
          <IconButton onClick={() => loadDirectory(currentPath, true)} size="small">
            <Refresh />
          </IconButton>
        </Box>

        {/* Breadcrumbs */}
        <Breadcrumbs sx={{ mb: 2 }}>
          <Link
            component="button"
            variant="body2"
            onClick={() => loadDirectory(rootPath, true)}
            sx={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}
          >
            <Home sx={{ mr: 0.5 }} fontSize="small" />
            Root
          </Link>
          {pathParts.map((part, index) => (
            <Link
              key={index}
              component="button"
              variant="body2"
              onClick={() => handleBreadcrumbClick(index)}
              sx={{ cursor: 'pointer' }}
            >
              {part}
            </Link>
          ))}
        </Breadcrumbs>

        {/* Search */}
        <TextField
          fullWidth
          size="small"
          placeholder="Search files..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Search />
                </InputAdornment>
              ),
            },
          }}
        />

        {/* Pattern Input (for glob matching) */}
        {allowPattern && (
          <Box mt={2}>
            <TextField
              fullWidth
              size="small"
              placeholder="Enter pattern (e.g., Movies/*.tiff, relion30_tutorial/Movies/*.tiff)"
              value={patternInput}
              onChange={(e) => setPatternInput(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  searchPattern(patternInput);
                }
              }}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <Pattern />
                    </InputAdornment>
                  ),
                  endAdornment: (
                    <Box display="flex" gap={1}>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => searchPattern(patternInput)}
                        disabled={!patternInput.trim()}
                      >
                        Search
                      </Button>
                      <Button
                        size="small"
                        variant="contained"
                        color="primary"
                        onClick={handlePatternSelect}
                        disabled={!patternInput.trim()}
                      >
                        Use Pattern
                      </Button>
                    </Box>
                  ),
                },
              }}
              helperText="Type a glob pattern and click 'Search' to preview, or 'Use Pattern' to select it directly"
            />
            {patternMode && (
              <Box mt={1} display="flex" alignItems="center" gap={1}>
                <Chip
                  label={`${patternCount} files match`}
                  color="primary"
                  size="small"
                />
                <Button
                  size="small"
                  startIcon={<ArrowBack />}
                  onClick={() => {
                    setPatternMode(false);
                    setPatternResults([]);
                  }}
                >
                  Back to Browser
                </Button>
              </Box>
            )}
          </Box>
        )}

        {/* Multi-select controls */}
        {multiSelect && (
          <Box mt={2} display="flex" gap={1} alignItems="center" flexWrap="wrap">
            <Button
              size="small"
              variant="outlined"
              startIcon={<SelectAll />}
              onClick={selectAllFiles}
            >
              Select All {fileFilter ? fileFilter.toUpperCase() : 'Files'}
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<Clear />}
              onClick={clearSelection}
              disabled={selectedFiles.size === 0}
            >
              Clear
            </Button>
            <Chip
              label={`${selectedFiles.size} selected`}
              color={selectedFiles.size > 0 ? 'primary' : 'default'}
              size="small"
            />
            <Button
              size="small"
              variant="contained"
              color="success"
              startIcon={<CheckCircle />}
              onClick={confirmMultiSelection}
              disabled={selectedFiles.size === 0}
            >
              Confirm Selection
            </Button>
          </Box>
        )}
      </Box>

      <Divider />

      {/* Node Browser (if nodeType specified) — collapsed by default so it
          doesn't push the project folders out of view on projects with many
          prior jobs. */}
      {nodeType && nodes.length > 0 && (
        <>
          <Accordion
            disableGutters
            elevation={0}
            square
            sx={{
              '&:before': { display: 'none' },
              bgcolor: 'transparent',
            }}
          >
            <AccordionSummary
              expandIcon={<ExpandMore />}
              sx={{ px: 2, minHeight: 48, '& .MuiAccordionSummary-content': { my: 1 } }}
            >
              <Typography variant="subtitle2">
                Available Nodes ({nodeType})
                <Typography
                  component="span"
                  variant="caption"
                  color="text.secondary"
                  sx={{ ml: 1 }}
                >
                  {nodes.length} match{nodes.length === 1 ? '' : 'es'}
                </Typography>
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 2, pt: 0, pb: 2, maxHeight: 240, overflow: 'auto' }}>
              <Box display="flex" flexWrap="wrap" gap={1}>
                {nodes.map((node, index) => (
                  <Chip
                    key={index}
                    label={node.name}
                    size="small"
                    icon={<FolderOpen />}
                    onClick={() => onFileSelect && onFileSelect(node.path)}
                    clickable
                  />
                ))}
              </Box>
            </AccordionDetails>
          </Accordion>
          <Divider />
        </>
      )}

      {/* Select Current Folder Button (only in directory selection mode) */}
      {selectDirectory && (
        <Box p={2} sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Button
            variant="contained"
            color="primary"
            fullWidth
            startIcon={<CheckCircle />}
            onClick={() => {
              if (onFileSelect) {
                const dirPath = currentPath.endsWith('/') ? currentPath : currentPath + '/';
                onFileSelect(dirPath);
              }
            }}
          >
            Select This Folder: {currentPath.split('/').filter(p => p).pop() || 'Root'}
          </Button>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Click a folder to navigate into it, or click the button above to select the current folder
          </Typography>
        </Box>
      )}

      {/* File List */}
      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {loading ? (
          <Box p={2}>
            <Typography variant="body2" color="text.secondary">
              Loading...
            </Typography>
          </Box>
        ) : patternMode ? (
          // Pattern search results
          patternResults.length === 0 ? (
            <Box p={2}>
              <Typography variant="body2" color="text.secondary">
                No files found matching pattern: {patternInput}
              </Typography>
            </Box>
          ) : (
            <List>
              {patternResults.map((item, index) => (
                <ListItem key={index} disablePadding>
                  <ListItemButton
                    onClick={() => {
                      if (onFileSelect) {
                        onFileSelect(item.path);
                      }
                    }}
                  >
                    <ListItemIcon>{getFileIcon({ name: item.name, type: item.type, path: item.path })}</ListItemIcon>
                    <ListItemText
                      primary={
                        <Box display="flex" alignItems="center" gap={1}>
                          <Typography variant="body2">{item.name}</Typography>
                          {item.type === 'file' && getFileTypeLabel(item.name) && (
                            <Chip label={getFileTypeLabel(item.name)} size="small" />
                          )}
                        </Box>
                      }
                      secondary={item.path}
                    />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          )
        ) : getFilteredFiles().length === 0 ? (
          <Box p={2}>
            <Typography variant="body2" color="text.secondary">
              {searchQuery ? 'No files found matching your search' : 'This directory is empty'}
            </Typography>
          </Box>
        ) : (
          <List>
            {getFilteredFiles().map((item, index) => (
              <ListItem key={index} disablePadding>
                {multiSelect && item.type === 'file' ? (
                  // Multi-select mode - show checkbox for files
                  <ListItemButton
                    onClick={() => toggleFileSelection(item.path)}
                    selected={selectedFiles.has(item.path)}
                  >
                    <Checkbox
                      edge="start"
                      checked={selectedFiles.has(item.path)}
                      tabIndex={-1}
                      disableRipple
                      size="small"
                    />
                    <ListItemIcon>{getFileIcon(item)}</ListItemIcon>
                    <ListItemText
                      primary={
                        <Box display="flex" alignItems="center" gap={1}>
                          <Typography variant="body2">{item.name}</Typography>
                          {getFileTypeLabel(item.name) && (
                            <Chip label={getFileTypeLabel(item.name)} size="small" />
                          )}
                        </Box>
                      }
                      secondary="Click to select"
                    />
                  </ListItemButton>
                ) : (
                  // Normal mode or directory
                  <ListItemButton
                    onClick={() => handleItemClick(item)}
                    onDoubleClick={() => handleItemDoubleClick(item)}
                  >
                    <ListItemIcon>{getFileIcon(item)}</ListItemIcon>
                    <ListItemText
                      primary={
                        <Box display="flex" alignItems="center" gap={1}>
                          <Typography variant="body2">{item.name}</Typography>
                          {item.type === 'file' && getFileTypeLabel(item.name) && (
                            <Chip label={getFileTypeLabel(item.name)} size="small" />
                          )}
                          {item.type === 'dir' && selectDirectory && (
                            <Chip label="Double-click to select" size="small" variant="outlined" />
                          )}
                        </Box>
                      }
                      secondary={item.type === 'dir' ? 'Directory' : 'File'}
                    />
                  </ListItemButton>
                )}
              </ListItem>
            ))}
          </List>
        )}
      </Box>
    </Paper>
  );
};

export default FileBrowser;
