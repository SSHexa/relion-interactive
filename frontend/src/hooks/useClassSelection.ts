import { useCallback, useEffect, useMemo, useState } from 'react';
import { getAppBasePath } from '../services/api';

const API_BASE = getAppBasePath();

// Class2D and Class3D return the exact same shape from the API,
// so the hook is generic over the kind via the URL segment.
export interface ClassRow {
  classNumber: number;
  distribution: number;
  resolution: number;
  particleCount: number;
  imageUrl: string;
}

export type ClassKind = 'class2d' | 'class3d';

export type SortOption = 'distribution' | 'resolution' | 'particleCount' | 'classNumber';

export interface UseClassSelectionOptions {
  open: boolean;
  jobId: string;
  kind: ClassKind;
  defaultItemsPerRow: number;
  /** When true, the first class is auto-selected for viewing (3D viewer use). */
  autoViewFirstOnLoad?: boolean;
  /** Fired after open->true with both cleared (used by 3D to also reset its viewer). */
  onOpenReset?: () => void;
}

/**
 * Owns all the state, effects, and handlers shared between
 * Class2DSelectionDialog and Class3DSelectionDialog. The dialogs
 * differ only in presentation (right panel layout, card style, and
 * 3D viewer integration) — every piece of LOGIC lives here.
 *
 * Replaces ~95% of the duplication between the two files with one
 * shared source of truth.
 */
export function useClassSelection(opts: UseClassSelectionOptions) {
  const { open, jobId, kind, defaultItemsPerRow, autoViewFirstOnLoad, onOpenReset } = opts;

  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedClasses, setSelectedClasses] = useState<Set<number>>(new Set());
  const [totalParticles, setTotalParticles] = useState(0);
  const [iteration, setIteration] = useState(0);

  // UI controls
  const [sortBy, setSortBy] = useState<SortOption>('distribution');
  const [sortAsc] = useState(false);
  const [filterMin, setFilterMin] = useState(0);
  const [filterMax, setFilterMax] = useState(100);
  const [itemsPerRow, setItemsPerRow] = useState<number>(defaultItemsPerRow);

  // Returned so callers (3D viewer) can use it. The hook itself doesn't
  // open a viewer — that's caller-side UI concern.
  const [firstClassOnLoad, setFirstClassOnLoad] = useState<number | null>(null);

  const fetchClasses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/jobs/${jobId}/${kind}/classes`);
      if (!response.ok) {
        throw new Error('Failed to fetch class data');
      }
      const data = await response.json();
      const rows: ClassRow[] = data.classes || [];
      setClasses(rows);
      setTotalParticles(data.totalParticles || 0);
      setIteration(data.iteration || 0);
      // Set filter max to the maximum distribution
      const maxDist = Math.max(...rows.map((c) => c.distribution), 0);
      setFilterMax(Math.ceil(maxDist));
      if (autoViewFirstOnLoad && rows.length > 0) {
        setFirstClassOnLoad(rows[0].classNumber);
      } else {
        setFirstClassOnLoad(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [jobId, kind, autoViewFirstOnLoad]);

  // Fetch + reset on open
  useEffect(() => {
    if (open && jobId) {
      fetchClasses();
      setSelectedClasses(new Set());
      onOpenReset?.();
    }
    // onOpenReset is intentionally not a dep — callers pass a stable
    // setter or wrap themselves; this matches the original 3D behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, jobId, fetchClasses]);

  // Sort + filter
  const displayedClasses = useMemo(() => {
    const filtered = classes.filter(
      (c) => c.distribution >= filterMin && c.distribution <= filterMax,
    );
    filtered.sort((a, b) => {
      const aVal = a[sortBy];
      const bVal = b[sortBy];
      return sortAsc ? aVal - bVal : bVal - aVal;
    });
    return filtered;
  }, [classes, sortBy, sortAsc, filterMin, filterMax]);

  // Selection statistics
  const selectedStats = useMemo(() => {
    const selectedArr = classes.filter((c) => selectedClasses.has(c.classNumber));
    const particleCount = selectedArr.reduce((sum, c) => sum + c.particleCount, 0);
    const percentage = totalParticles > 0 ? (particleCount / totalParticles) * 100 : 0;
    return {
      classCount: selectedClasses.size,
      particleCount,
      percentage,
    };
  }, [selectedClasses, classes, totalParticles]);

  // Slider max
  const maxDistribution = useMemo(() => {
    if (classes.length === 0) return 100;
    return Math.ceil(Math.max(...classes.map((c) => c.distribution)));
  }, [classes]);

  // Selection handlers
  const toggleClass = useCallback((classNumber: number) => {
    setSelectedClasses((prev) => {
      const next = new Set(prev);
      if (next.has(classNumber)) {
        next.delete(classNumber);
      } else {
        next.add(classNumber);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedClasses(new Set(displayedClasses.map((c) => c.classNumber)));
  }, [displayedClasses]);

  const deselectAll = useCallback(() => {
    setSelectedClasses(new Set());
  }, []);

  const invertSelection = useCallback(() => {
    const displayed = new Set(displayedClasses.map((c) => c.classNumber));
    setSelectedClasses((prev) => {
      const next = new Set<number>();
      displayed.forEach((cn) => {
        if (!prev.has(cn)) {
          next.add(cn);
        }
      });
      return next;
    });
  }, [displayedClasses]);

  // Save and Run hit the same backend endpoint; the caller decides what
  // to do with the returned relativePath. Returns null on error or empty
  // selection so callers can early-return without doing their own validation.
  const submitSelection = useCallback(
    async (): Promise<string | null> => {
      if (selectedClasses.size === 0) return null;
      setSaving(true);
      try {
        const response = await fetch(`${API_BASE}/api/jobs/${jobId}/${kind}/select`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selectedClasses: Array.from(selectedClasses) }),
        });
        if (!response.ok) {
          throw new Error('Failed to save selection');
        }
        const data = await response.json();
        return data.relativePath as string;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save');
        return null;
      } finally {
        setSaving(false);
      }
    },
    [jobId, kind, selectedClasses],
  );

  return {
    // data
    classes,
    displayedClasses,
    selectedClasses,
    selectedStats,
    totalParticles,
    iteration,
    firstClassOnLoad,
    // status
    loading,
    saving,
    error,
    // sort/filter controls
    sortBy,
    setSortBy,
    sortAsc,
    filterMin,
    setFilterMin,
    filterMax,
    setFilterMax,
    itemsPerRow,
    setItemsPerRow,
    maxDistribution,
    // actions
    toggleClass,
    selectAll,
    deselectAll,
    invertSelection,
    submitSelection,
    setError,
  };
}
