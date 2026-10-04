import React, { useState, useMemo, useRef } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Sparkles, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { OcrBoundingBox, EditableReviewLine } from '../../types/po';

interface DocumentVisualHudProps {
  boxes: OcrBoundingBox[];
  lines: EditableReviewLine[];
  hoveredLineId: string | null;
  onHoverLine: (id: string | null) => void;
  faultyRows: Map<string, { expected: number; actual: number }>;
}

export const DocumentVisualHud: React.FC<DocumentVisualHudProps> = ({
  boxes,
  lines,
  hoveredLineId,
  onHoverLine,
  faultyRows,
}) => {
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [selectedBoxIndex, setSelectedBoxIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Derive bounding geometry bounds for SVG viewbox
  const bounds = useMemo(() => {
    if (!boxes || boxes.length === 0) {
      return { minX: 0, minY: 0, maxX: 1000, maxY: 1400, width: 1000, height: 1400 };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    boxes.forEach((b) => {
      const bx = Number.isFinite(b.x) ? b.x : 0;
      const by = Number.isFinite(b.y) ? b.y : 0;
      const bw = Number.isFinite(b.w) ? b.w : 100;
      const bh = Number.isFinite(b.h) ? b.h : 30;

      if (bx < minX) minX = bx;
      if (by < minY) minY = by;
      if (bx + bw > maxX) maxX = bx + bw;
      if (by + bh > maxY) maxY = by + bh;
    });

    // If coordinates are normalized 0..1, expand to 1000x1400
    if (maxX <= 1.5 && maxY <= 1.5) {
      return { minX: 0, minY: 0, maxX: 1000, maxY: 1400, width: 1000, height: 1400, isNormalized: true };
    }

    const padding = 20;
    const width = Math.max(400, maxX - minX + padding * 2);
    const height = Math.max(600, maxY - minY + padding * 2);

    return { minX: minX - padding, minY: minY - padding, maxX, maxY, width, height, isNormalized: false };
  }, [boxes]);

  // Associate each box to a table line (if text matches)
  const boxLineAssociation = useMemo(() => {
    const map = new Map<number, string>();
    boxes.forEach((box, bIdx) => {
      const bText = (box.text || '').toLowerCase().trim();
      if (!bText) return;

      const matchingLine = lines.find((l) => {
        const lDesc = (l.raw_description || '').toLowerCase();
        return lDesc.includes(bText) || bText.includes(lDesc.slice(0, 15));
      });

      if (matchingLine) {
        map.set(bIdx, matchingLine.client_id);
      }
    });
    return map;
  }, [boxes, lines]);

  const handleZoom = (delta: number) => {
    setZoomLevel((prev) => Math.min(2.5, Math.max(0.6, Math.round((prev + delta) * 10) / 10)));
  };

  const handleResetZoom = () => {
    setZoomLevel(1);
  };

  const selectedBox = selectedBoxIndex !== null && boxes[selectedBoxIndex] ? boxes[selectedBoxIndex] : null;

  return (
    <div className="flex flex-col h-full bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden shadow-inner select-none">
      {/* HUD Control Bar */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-900 border-b border-slate-800 text-xs">
        <div className="flex items-center gap-1.5 text-slate-300 font-bold">
          <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-[11px] uppercase tracking-wider">HUD Spatial IA & Bounding Boxes</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
            {boxes.length} boîtes
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => handleZoom(-0.2)}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition cursor-pointer"
            title="Zoom Arrière"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="text-[10px] font-mono text-slate-400 px-1">
            {Math.round(zoomLevel * 100)}%
          </span>
          <button
            type="button"
            onClick={() => handleZoom(0.2)}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition cursor-pointer"
            title="Zoom Avant"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleResetZoom}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition cursor-pointer"
            title="Ajuster Vue"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* SVG Interactive Canvas */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto p-4 flex items-center justify-center bg-slate-950/80 relative"
      >
        <div
          className="transition-transform duration-150 ease-out origin-top-left"
          style={{ transform: `scale(${zoomLevel})` }}
        >
          <svg
            viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}
            className="w-[340px] sm:w-[380px] h-auto bg-slate-900 border border-slate-700/80 rounded-xl shadow-2xl overflow-visible"
            style={{ minHeight: '460px' }}
          >
            {/* Background Grid Pattern */}
            <defs>
              <pattern id="grid-pattern" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(51, 65, 85, 0.2)" strokeWidth="0.8" />
              </pattern>
            </defs>
            <rect
              x={bounds.minX}
              y={bounds.minY}
              width={bounds.width}
              height={bounds.height}
              fill="url(#grid-pattern)"
            />

            {/* Bounding Boxes */}
            {boxes.map((box, idx) => {
              const x = bounds.isNormalized ? box.x * 1000 : box.x;
              const y = bounds.isNormalized ? box.y * 1400 : box.y;
              const w = bounds.isNormalized ? box.w * 1000 : box.w;
              const h = bounds.isNormalized ? box.h * 1400 : box.h;

              const lineId = boxLineAssociation.get(idx);
              const isLineHovered = lineId && lineId === hoveredLineId;
              const isSelected = selectedBoxIndex === idx;

              const isFaulty = lineId && faultyRows.has(lineId);

              // Colors based on status
              let strokeColor = '#64748b'; // slate-500
              let fillColor = 'rgba(100, 116, 139, 0.1)';

              if (isFaulty) {
                strokeColor = '#f43f5e'; // rose-500
                fillColor = 'rgba(244, 63, 94, 0.25)';
              } else if (isLineHovered || isSelected) {
                strokeColor = '#6366f1'; // indigo-500
                fillColor = 'rgba(99, 102, 241, 0.35)';
              } else if (lineId) {
                strokeColor = '#10b981'; // emerald-500
                fillColor = 'rgba(16, 185, 129, 0.15)';
              }

              return (
                <g
                  key={`box_${idx}`}
                  className="cursor-pointer transition-all duration-150 group"
                  onMouseEnter={() => {
                    setSelectedBoxIndex(idx);
                    if (lineId) onHoverLine(lineId);
                  }}
                  onMouseLeave={() => {
                    setSelectedBoxIndex(null);
                    onHoverLine(null);
                  }}
                  onClick={() => setSelectedBoxIndex(idx)}
                >
                  {/* Bounding Rectangle */}
                  <rect
                    x={x}
                    y={y}
                    width={Math.max(20, w)}
                    height={Math.max(14, h)}
                    rx={3}
                    fill={fillColor}
                    stroke={strokeColor}
                    strokeWidth={isLineHovered || isSelected ? 2.5 : 1.2}
                    strokeDasharray={isFaulty ? '3,2' : undefined}
                    className="transition-all duration-150"
                  />

                  {/* Text Label inside Box */}
                  <text
                    x={x + 3}
                    y={y + Math.max(10, h - 3)}
                    fill={isLineHovered || isSelected ? '#ffffff' : '#cbd5e1'}
                    fontSize={Math.max(8, Math.min(12, h * 0.75))}
                    fontFamily="monospace"
                    className="pointer-events-none select-none"
                  >
                    {box.text.length > 28 ? `${box.text.slice(0, 26)}…` : box.text}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* Selected Box Inspection Bar */}
      {selectedBox && (
        <div className="p-2.5 bg-slate-900 border-t border-slate-800 text-[11px] flex items-center justify-between gap-2 shrink-0 animate-in fade-in">
          <div className="flex items-center gap-2 min-w-0">
            {boxLineAssociation.has(selectedBoxIndex!) && faultyRows.has(boxLineAssociation.get(selectedBoxIndex!)!) ? (
              <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            )}
            <div className="min-w-0">
              <p className="font-mono text-white truncate max-w-[220px]">
                {selectedBox.text}
              </p>
              <span className="text-[9px] text-slate-400 font-mono">
                Confiance OCR : {Math.round((selectedBox.confidence || 0.95) * 100)}% | [x:{Math.round(selectedBox.x)}, y:{Math.round(selectedBox.y)}]
              </span>
            </div>
          </div>
          <span className="text-[9px] uppercase px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800 font-bold shrink-0">
            Boîte #{selectedBoxIndex! + 1}
          </span>
        </div>
      )}
    </div>
  );
};
