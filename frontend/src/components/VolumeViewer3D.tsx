import React, { useState, useRef, useEffect, useMemo, Suspense } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, Html } from '@react-three/drei';
import {
  Box,
  Paper,
  Typography,
  Slider,
  Button,
  CircularProgress,
  IconButton,
  Tooltip,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  FormControlLabel,
  Switch,
} from '@mui/material';
import {
  Refresh,
  Fullscreen,
  ViewInAr,
  Opacity,
  RestartAlt,
} from '@mui/icons-material';
import * as THREE from 'three';
import { getAppBasePath } from '../services/api';

const API_BASE = getAppBasePath();

interface MeshData {
  vertices: number[];
  normals: number[];
  indices: number[];
  threshold: number;
  volumeSize: number[];
  voxelSize: number;
  minVal: number;
  maxVal: number;
  suggestedThreshold: number;
}

interface VolumeViewer3DProps {
  jobId: string;
  mrcFile?: string;
  title?: string;
}

// The 3D mesh component
const VolumeMesh: React.FC<{
  meshData: MeshData;
  wireframe: boolean;
  color: string;
  opacity: number;
}> = ({ meshData, wireframe, color, opacity }) => {
  const meshRef = useRef<THREE.Mesh>(null);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();

    // Set vertices
    const vertices = new Float32Array(meshData.vertices);
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

    // Set normals
    const normals = new Float32Array(meshData.normals);
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

    // Set indices
    const indices = new Uint32Array(meshData.indices);
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    // Center the geometry
    geo.computeBoundingBox();
    const center = new THREE.Vector3();
    geo.boundingBox?.getCenter(center);
    geo.translate(-center.x, -center.y, -center.z);

    return geo;
  }, [meshData]);

  // Auto-rotate (currently disabled)
  useFrame(() => {
    // Slight auto-rotation when not interacting
    // if (meshRef.current) {
    //   meshRef.current.rotation.y += delta * 0.1;
    // }
  });

  return (
    <mesh ref={meshRef} geometry={geometry}>
      <meshPhongMaterial
        color={color}
        wireframe={wireframe}
        transparent={opacity < 1}
        opacity={opacity}
        side={THREE.DoubleSide}
        shininess={50}
      />
    </mesh>
  );
};

// Loading component
const LoadingIndicator = () => (
  <Html center>
    <Box display="flex" flexDirection="column" alignItems="center" gap={1}>
      <CircularProgress size={40} />
      <Typography variant="body2" color="text.secondary">
        Generating isosurface...
      </Typography>
    </Box>
  </Html>
);

// Camera controller component
const CameraController: React.FC<{ resetKey: number }> = ({ resetKey }) => {
  const { camera } = useThree();

  useEffect(() => {
    camera.position.set(150, 100, 150);
    camera.lookAt(0, 0, 0);
  }, [resetKey, camera]);

  return <OrbitControls enableDamping dampingFactor={0.1} />;
};

const VolumeViewer3D: React.FC<VolumeViewer3DProps> = ({ jobId, mrcFile, title }) => {
  const [meshData, setMeshData] = useState<MeshData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState<number>(0.5);
  const [pendingThreshold, setPendingThreshold] = useState<number>(0.5);
  const [wireframe, setWireframe] = useState(false);
  const [opacity, setOpacity] = useState(1);
  const [color, setColor] = useState('#4fc3f7');
  const [resetKey, setResetKey] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const colorOptions = [
    { value: '#4fc3f7', label: 'Blue' },
    { value: '#81c784', label: 'Green' },
    { value: '#ffb74d', label: 'Orange' },
    { value: '#f06292', label: 'Pink' },
    { value: '#ba68c8', label: 'Purple' },
    { value: '#e0e0e0', label: 'Gray' },
  ];

  const loadMesh = async (thresholdValue?: number) => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (mrcFile) params.append('mrc_file', mrcFile);
      if (thresholdValue !== undefined) params.append('threshold', thresholdValue.toString());

      const response = await fetch(
        `${API_BASE}/api/jobs/${jobId}/generate-mesh?${params.toString()}`
      );

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to generate mesh');
      }

      const data: MeshData = await response.json();
      setMeshData(data);

      // Update threshold from server response if this is initial load
      if (thresholdValue === undefined) {
        setThreshold(data.suggestedThreshold);
        setPendingThreshold(data.suggestedThreshold);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load mesh');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMesh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, mrcFile]);

  const handleThresholdChange = (_: Event, value: number | number[]) => {
    setPendingThreshold(value as number);
  };

  const handleThresholdCommit = () => {
    if (pendingThreshold !== threshold) {
      setThreshold(pendingThreshold);
      loadMesh(pendingThreshold);
    }
  };

  const handleReset = () => {
    setResetKey(k => k + 1);
    setWireframe(false);
    setOpacity(1);
    if (meshData) {
      setPendingThreshold(meshData.suggestedThreshold);
      setThreshold(meshData.suggestedThreshold);
      loadMesh(meshData.suggestedThreshold);
    }
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement && containerRef.current) {
      containerRef.current.requestFullscreen();
      setIsFullscreen(true);
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const vertexCount = meshData ? meshData.vertices.length / 3 : 0;
  const triangleCount = meshData ? meshData.indices.length / 3 : 0;

  return (
    <Paper
      ref={containerRef}
      sx={{
        p: 2,
        height: isFullscreen ? '100vh' : 600,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: isFullscreen ? (theme) => theme.palette.mode === 'dark' ? '#1a1a2e' : '#e8eaf6' : 'background.paper',
      }}
    >
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
        <Typography variant="h6">
          <ViewInAr sx={{ mr: 1, verticalAlign: 'middle' }} />
          {title || '3D Volume Viewer'}
        </Typography>
        <Box>
          <Tooltip title="Reset View">
            <IconButton onClick={handleReset} size="small">
              <RestartAlt />
            </IconButton>
          </Tooltip>
          <Tooltip title="Fullscreen">
            <IconButton onClick={toggleFullscreen} size="small">
              <Fullscreen />
            </IconButton>
          </Tooltip>
          <Tooltip title="Reload">
            <IconButton onClick={() => loadMesh(threshold)} size="small" disabled={loading}>
              <Refresh />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Controls */}
      <Box sx={{ mb: 2 }}>
        <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap">
          {/* Threshold/Isosurface Level */}
          <Box sx={{ minWidth: 200, flex: 1 }}>
            <Typography variant="caption" color="text.secondary">
              Isosurface Level (Threshold)
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <Slider
                value={pendingThreshold}
                onChange={handleThresholdChange}
                onChangeCommitted={handleThresholdCommit}
                min={0}
                max={1}
                step={0.01}
                size="small"
                valueLabelDisplay="auto"
                valueLabelFormat={(v) => v.toFixed(2)}
              />
              <Button
                size="small"
                variant="outlined"
                onClick={handleThresholdCommit}
                disabled={loading || pendingThreshold === threshold}
              >
                Apply
              </Button>
            </Stack>
          </Box>

          {/* Opacity */}
          <Box sx={{ minWidth: 120 }}>
            <Typography variant="caption" color="text.secondary">
              <Opacity sx={{ fontSize: 14, mr: 0.5, verticalAlign: 'middle' }} />
              Opacity
            </Typography>
            <Slider
              value={opacity}
              onChange={(_, v) => setOpacity(v as number)}
              min={0.1}
              max={1}
              step={0.1}
              size="small"
              valueLabelDisplay="auto"
            />
          </Box>

          {/* Color */}
          <Box>
            <Typography variant="caption" color="text.secondary">Color</Typography>
            <ToggleButtonGroup
              value={color}
              exclusive
              onChange={(_, v) => v && setColor(v)}
              size="small"
            >
              {colorOptions.map((opt) => (
                <ToggleButton key={opt.value} value={opt.value} sx={{ p: 0.5 }}>
                  <Box
                    sx={{
                      width: 20,
                      height: 20,
                      bgcolor: opt.value,
                      borderRadius: 0.5,
                      border: color === opt.value ? '2px solid white' : '1px solid #666',
                    }}
                  />
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Box>

          {/* Wireframe */}
          <FormControlLabel
            control={
              <Switch
                checked={wireframe}
                onChange={(e) => setWireframe(e.target.checked)}
                size="small"
              />
            }
            label={<Typography variant="caption">Wireframe</Typography>}
          />
        </Stack>
      </Box>

      {/* 3D Canvas */}
      <Box
        sx={{
          flex: 1,
          borderRadius: 1,
          overflow: 'hidden',
          bgcolor: (theme) => theme.palette.mode === 'dark' ? '#1a1a2e' : '#e8eaf6',
          position: 'relative',
        }}
      >
        {error ? (
          <Box
            display="flex"
            justifyContent="center"
            alignItems="center"
            height="100%"
            flexDirection="column"
            gap={2}
          >
            <Typography color="error">{error}</Typography>
            <Button variant="outlined" onClick={() => loadMesh()}>
              Retry
            </Button>
          </Box>
        ) : (
          <Canvas
            camera={{ position: [150, 100, 150], fov: 50, near: 0.1, far: 10000 }}
            gl={{ antialias: true }}
          >
            <Suspense fallback={<LoadingIndicator />}>
              <ambientLight intensity={0.4} />
              <directionalLight position={[100, 100, 50]} intensity={0.8} />
              <directionalLight position={[-100, -100, -50]} intensity={0.4} />
              <pointLight position={[0, 100, 0]} intensity={0.3} />

              {meshData && !loading && (
                <VolumeMesh
                  meshData={meshData}
                  wireframe={wireframe}
                  color={color}
                  opacity={opacity}
                />
              )}

              {loading && <LoadingIndicator />}

              <CameraController resetKey={resetKey} />
              <Grid
                args={[200, 200]}
                position={[0, -50, 0]}
                cellColor="#444"
                sectionColor="#666"
              />
            </Suspense>
          </Canvas>
        )}
      </Box>

      {/* Stats */}
      {meshData && (
        <Box sx={{ mt: 1, display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="caption" color="text.secondary">
            Volume: {meshData.volumeSize.join(' x ')} voxels
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Voxel Size: {meshData.voxelSize.toFixed(2)} Å
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Vertices: {vertexCount.toLocaleString()}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Triangles: {triangleCount.toLocaleString()}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Threshold: {threshold.toFixed(3)}
          </Typography>
        </Box>
      )}
    </Paper>
  );
};

export default VolumeViewer3D;
