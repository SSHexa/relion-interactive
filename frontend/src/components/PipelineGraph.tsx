import React, { useCallback, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Node,
  Edge,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  MarkerType,
  NodeTypes,
  MiniMap,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { PipelineProcess, ProcessStatus } from '../types/relion';
import { Box, Paper, Typography, Chip } from '@mui/material';
import {
  PlayArrow,
  Schedule,
  CheckCircle,
  Error,
  Cancel,
} from '@mui/icons-material';
import { useThemeContext } from '../contexts/ThemeContext';

// Define RELION pipeline job type order
const JOB_TYPE_ORDER = [
  'Import', 'MotionCorr', 'CtfFind', 'ManualPick', 'AutoPick',
  'Extract', 'Class2D', 'ClassSelect', 'InitialModel',
  'Class3D', 'Refine3D', 'CtfRefine', 'Polish',
  'MaskCreate', 'PostProcess', 'LocalRes', 'ModelAngelo', 'DynaMight', 'External'
];

// RELION 5 uses dotted subtypes (e.g. "Select.Interactive", "Modelangelo.Inference")
// and varies capitalization (Modelangelo vs ModelAngelo). Map raw types to a
// canonical family name in JOB_TYPE_ORDER so they share a column and stack
// vertically instead of all collapsing onto row 0 of the "unknown" column.
const TYPE_ALIASES: Record<string, string> = {
  select: 'ClassSelect',
  classselect: 'ClassSelect',
  modelangelo: 'ModelAngelo',
  localres: 'LocalRes',
  initial: 'InitialModel',
  initialmodel: 'InitialModel',
  motionrefine: 'Polish',
};

const canonicalType = (raw: string): string => {
  if (!raw) return 'External';
  const base = raw.split('.')[0];
  const lower = base.toLowerCase();
  const exact = JOB_TYPE_ORDER.find(t => t.toLowerCase() === lower);
  if (exact) return exact;
  return TYPE_ALIASES[lower] || base;
};

interface PipelineGraphProps {
  processes: PipelineProcess[];
  onProcessClick?: (processId: string) => void;
}

const getStatusColor = (status: ProcessStatus, isDark: boolean): string => {
  switch (status) {
    case ProcessStatus.RUNNING:
      return isDark ? '#22D3EE' : '#3B82F6';       // bright cyan
    case ProcessStatus.SCHEDULED:
      return isDark ? '#FBBF24' : '#F59E0B';
    case ProcessStatus.FINISHED_SUCCESS:
      return isDark ? '#34D399' : '#10B981';
    case ProcessStatus.FINISHED_FAILURE:
      return isDark ? '#F43F5E' : '#F43F5E';        // vivid rose
    case ProcessStatus.FINISHED_ABORTED:
      return isDark ? '#9CA3AF' : '#6B7280';
    default:
      return isDark ? '#9CA3AF' : '#6B7280';
  }
};

const getStatusIcon = (status: ProcessStatus) => {
  switch (status) {
    case ProcessStatus.RUNNING:
      return <PlayArrow fontSize="small" />;
    case ProcessStatus.SCHEDULED:
      return <Schedule fontSize="small" />;
    case ProcessStatus.FINISHED_SUCCESS:
      return <CheckCircle fontSize="small" />;
    case ProcessStatus.FINISHED_FAILURE:
      return <Error fontSize="small" />;
    case ProcessStatus.FINISHED_ABORTED:
      return <Cancel fontSize="small" />;
    default:
      return null;
  }
};

const getStatusLabel = (status: ProcessStatus): string => {
  switch (status) {
    case ProcessStatus.RUNNING:
      return 'Running';
    case ProcessStatus.SCHEDULED:
      return 'Scheduled';
    case ProcessStatus.FINISHED_SUCCESS:
      return 'Success';
    case ProcessStatus.FINISHED_FAILURE:
      return 'Failed';
    case ProcessStatus.FINISHED_ABORTED:
      return 'Aborted';
    default:
      return 'Unknown';
  }
};

// Custom node component with handles for edges
const ProcessNode = ({ data }: { data: any }) => {
  const isDark = data.isDarkMode || false;
  const statusColor = getStatusColor(data.status, isDark);
  const statusIcon = getStatusIcon(data.status);
  const statusLabel = getStatusLabel(data.status);

  const isRunning = data.status === ProcessStatus.RUNNING;

  return (
    <>
      {/* Target handle (left side - receives connections) */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          background: isDark ? '#4F46E5' : '#3B82F6',
          width: 10,
          height: 10,
          border: isDark ? '2px solid #060B14' : '2px solid white',
          boxShadow: isDark ? '0 0 6px rgba(79,70,229,0.6)' : 'none',
        }}
      />

      <Paper
        elevation={isDark ? 0 : 3}
        sx={{
          padding: 2,
          minWidth: 200,
          maxWidth: 260,
          height: 130,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          cursor: 'pointer',
          transition: 'all 220ms cubic-bezier(0.4,0,0.2,1)',
          bgcolor: isDark ? 'rgba(13,21,38,0.85)' : undefined,
          backdropFilter: isDark ? 'blur(20px) saturate(180%)' : undefined,
          WebkitBackdropFilter: isDark ? 'blur(20px) saturate(180%)' : undefined,
          border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(0,0,0,0.08)',
          // Colored left accent via inset shadow (avoids borderLeft override issues)
          boxShadow: isDark
            ? `inset 3px 0 0 ${statusColor}, inset 0 1px 0 rgba(255,255,255,0.08), 0 4px 16px rgba(0,0,0,0.3)`
            : `inset 3px 0 0 ${statusColor}, 0 2px 8px rgba(0,0,0,0.1)`,
          borderRadius: 2,
          position: 'relative',
          overflow: 'hidden',
          '&:hover': {
            transform: 'translateY(-2px)',
            boxShadow: isDark
              ? `inset 3px 0 0 ${statusColor}, 0 0 0 1px ${statusColor}40, 0 12px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.12)`
              : `inset 3px 0 0 ${statusColor}, 0 8px 25px rgba(0,0,0,0.15)`,
          },
          // Pulse glow for running nodes
          ...(isRunning && isDark && {
            animation: 'pulse 2s ease infinite',
          }),
        }}
      >
        <Box display="flex" alignItems="center" mb={1}>
          <Box sx={{ color: statusColor, mr: 1 }}>{statusIcon}</Box>
          <Typography variant="body2" fontWeight="bold">
            {data.type}
          </Typography>
        </Box>
        <Typography
          variant="body2"
          color="text.secondary"
          noWrap
          sx={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}
          title={(data.alias && data.alias !== 'None') ? data.alias : data.name}
        >
          {(data.alias && data.alias !== 'None') ? data.alias : data.name}
        </Typography>
        <Box mt={1}>
          <Chip
            label={statusLabel}
            size="small"
            variant="outlined"
            sx={{
              borderColor: statusColor,
              color: statusColor,
              fontSize: '0.7rem',
              fontWeight: 600,
              boxShadow: isDark ? `0 0 6px ${statusColor}50` : 'none',
              height: 20,
              '& .MuiChip-label': { px: 1 },
            }}
          />
        </Box>
      </Paper>

      {/* Source handle (right side - sends connections) */}
      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: isDark ? '#06B6D4' : '#3B82F6',
          width: 10,
          height: 10,
          border: isDark ? '2px solid #060B14' : '2px solid white',
          boxShadow: isDark ? '0 0 6px rgba(6,182,212,0.6)' : 'none',
        }}
      />
    </>
  );
};

const nodeTypes: NodeTypes = {
  processNode: ProcessNode,
};

const PipelineGraph: React.FC<PipelineGraphProps> = ({ processes, onProcessClick }) => {
  const { isDarkMode } = useThemeContext();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Build a map from job name/path to process for faster lookup
  const processMap = useMemo(() => {
    const map = new Map<string, PipelineProcess>();
    processes.forEach(p => {
      // Map by id (e.g., "job001")
      map.set(p.id, p);
      // Map by name (e.g., "Import/job001")
      map.set(p.name, p);
      // Map by name with trailing slash
      map.set(p.name + '/', p);
    });
    return map;
  }, [processes]);

  useEffect(() => {
    // Convert processes to nodes and edges
    const newNodes: Node[] = [];
    const newEdges: Edge[] = [];
    const addedEdges = new Set<string>();

    // Layout: use predefined column order for job types
    const columnWidth = 320;
    const rowHeight = 170;

    // Count jobs per type for row positioning
    const typeRowCount: Map<string, number> = new Map();

    // Get column index for a job type
    const getColumnIndex = (jobType: string): number => {
      const idx = JOB_TYPE_ORDER.indexOf(jobType);
      return idx >= 0 ? idx : JOB_TYPE_ORDER.length; // Unknown types go at the end
    };

    // Sort processes by their pipeline order
    const sortedProcesses = [...processes].sort((a, b) => {
      const colA = getColumnIndex(canonicalType(a.type));
      const colB = getColumnIndex(canonicalType(b.type));
      if (colA !== colB) return colA - colB;
      // Same type: sort by job number
      const numA = parseInt(a.id.replace(/\D/g, '')) || 0;
      const numB = parseInt(b.id.replace(/\D/g, '')) || 0;
      return numA - numB;
    });

    sortedProcesses.forEach((process) => {
      const family = canonicalType(process.type);
      const column = getColumnIndex(family);
      const rowCount = typeRowCount.get(family) || 0;
      typeRowCount.set(family, rowCount + 1);

      const position = {
        x: column * columnWidth,
        y: rowCount * rowHeight,
      };

      newNodes.push({
        id: process.id,
        type: 'processNode',
        position,
        data: {
          name: process.name,
          alias: process.alias,
          type: process.type,
          status: process.status,
          isDarkMode,
        },
      });

      // Create edges for input/output connections
      const inputNodes = process.inputNodes || [];

      inputNodes.forEach((inputNode) => {
        if (!inputNode) return;

        let sourceProcess: PipelineProcess | undefined;

        // Method 1: Try to extract job directory from input node path
        // e.g., "Import/job001/movies.star" -> look for process "Import/job001"
        const pathParts = inputNode.split('/');
        if (pathParts.length >= 2) {
          const jobDir = pathParts.slice(0, 2).join('/'); // e.g., "Import/job001"
          sourceProcess = processMap.get(jobDir) || processMap.get(jobDir + '/');
        }

        // Method 2: Try to find by job ID in the path
        if (!sourceProcess) {
          const jobIdMatch = inputNode.match(/(job\d+)/);
          if (jobIdMatch) {
            sourceProcess = processMap.get(jobIdMatch[1]);
          }
        }

        // Method 3: Check all processes for matching output nodes
        if (!sourceProcess) {
          sourceProcess = processes.find((p) => {
            const outputs = p.outputNodes || [];
            return outputs.some(out =>
              out === inputNode ||
              inputNode.startsWith(out.replace(/\/$/, '') + '/') ||
              out.startsWith(inputNode.replace(/\/$/, '') + '/')
            );
          });
        }

        // Create edge if we found a valid source
        if (sourceProcess && sourceProcess.id !== process.id) {
          const edgeId = `${sourceProcess.id}->${process.id}`;
          if (!addedEdges.has(edgeId)) {
            addedEdges.add(edgeId);
            newEdges.push({
              id: edgeId,
              source: sourceProcess.id,
              target: process.id,
              type: 'smoothstep',
              style: {
                stroke: isDarkMode ? '#4F46E5' : '#3B82F6',
                strokeWidth: 2,
                opacity: 0.8,
              },
              markerEnd: {
                type: MarkerType.ArrowClosed,
                color: isDarkMode ? '#4F46E5' : '#3B82F6',
              },
              animated: process.status === ProcessStatus.RUNNING,
            });
          }
        }
      });
    });

    // Debug: Log first few processes and their connections
    console.log('PipelineGraph Debug:');
    console.log('  Total processes:', processes.length);
    console.log('  ProcessMap keys:', Array.from(processMap.keys()).slice(0, 10));

    processes.slice(0, 5).forEach(p => {
      console.log(`  Process ${p.id}:`, {
        name: p.name,
        type: p.type,
        inputNodes: p.inputNodes,
        outputNodes: p.outputNodes,
      });
    });

    console.log('PipelineGraph: Created', newNodes.length, 'nodes and', newEdges.length, 'edges');
    if (newEdges.length > 0) {
      console.log('  Sample edges:', newEdges.slice(0, 5).map(e => `${e.source} -> ${e.target}`));
    } else {
      console.log('  No edges created! Check if inputNodes/outputNodes are populated.');
    }

    setNodes(newNodes);
    setEdges(newEdges);
  }, [processes, processMap, isDarkMode, setNodes, setEdges]);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (onProcessClick) {
        onProcessClick(node.id);
      }
    },
    [onProcessClick]
  );

  // Fit view options to ensure all nodes are visible
  const fitViewOptions = useMemo(() => ({
    padding: 0.2,
    includeHiddenNodes: false,
    minZoom: 0.1,
    maxZoom: 1.5,
  }), []);

  return (
    <Box sx={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={fitViewOptions}
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{
          type: 'smoothstep',
          style: { stroke: isDarkMode ? '#4F46E5' : '#3B82F6', strokeWidth: 2, opacity: 0.8 },
        }}
        attributionPosition="bottom-left"
      >
        <Controls showInteractive={false} />
        <MiniMap
          nodeStrokeWidth={3}
          zoomable
          pannable
          style={{
            backgroundColor: isDarkMode ? '#060B14' : '#f5f5f5',
            border: isDarkMode ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e0e0e0',
            borderRadius: 8,
          }}
        />
        <Background
          gap={24}
          size={1}
          color={isDarkMode ? 'rgba(255,255,255,0.05)' : '#e0e0e0'}
          style={{ backgroundColor: isDarkMode ? '#060B14' : '#fafafa' }}
        />
      </ReactFlow>
    </Box>
  );
};

export default PipelineGraph;
