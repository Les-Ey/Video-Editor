import React, { useEffect, useRef, useState } from 'react';
import {
  KEN_BURNS_PRESET_LABELS,
  KenBurnsPreset,
  MediaAssetKind,
  ProjectMediaAsset,
  TimelineClip,
  TrackType,
  VideoProjectManifest,
} from '../../shared/types';
import {
  Film,
  Music,
  Mic,
  Sparkles,
  Plus,
  Upload,
  Sliders,
  Image as ImageIcon,
} from 'lucide-react';

interface MediaBinAndInspectorProps {
  project: VideoProjectManifest;
  playhead: number;
  selectedClipId: string | null;
  lastImportedAssetId?: string | null;
  isExpandedWidth?: boolean;
  onImportMedia: (kind: MediaAssetKind) => void;
  onUpdateProject: (updater: (prev: VideoProjectManifest) => VideoProjectManifest) => void;
}

export const MediaBinAndInspector: React.FC<MediaBinAndInspectorProps> = ({
  project,
  playhead,
  selectedClipId,
  lastImportedAssetId,
  isExpandedWidth,
  onImportMedia,
  onUpdateProject,
}) => {
  const [activeTab, setActiveTab] = useState<'all' | 'video' | 'dialogue' | 'sfx-bgm'>('all');
  const assetRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const filteredAssets = project.assets.filter((a) => {
    if (activeTab === 'video') return a.kind === 'video' || a.kind === 'image';
    if (activeTab === 'dialogue') return a.kind === 'dialogue';
    if (activeTab === 'sfx-bgm') return a.kind === 'sfx' || a.kind === 'music';
    return true;
  });

  // Auto-scroll to the asset that was just imported (Topic 15)
  useEffect(() => {
    if (!lastImportedAssetId) return;
    const isVisibleInCurrentTab = filteredAssets.some((a) => a.id === lastImportedAssetId);
    if (!isVisibleInCurrentTab && activeTab !== 'all') {
      setActiveTab('all');
      return;
    }
    const timer = setTimeout(() => {
      const el = assetRowRefs.current.get(lastImportedAssetId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [lastImportedAssetId, activeTab, filteredAssets.length]);

  // Find currently selected clip and its asset
  let selectedClip: TimelineClip | null = null;
  let selectedTrackType: TrackType | null = null;
  for (const track of project.timeline.tracks) {
    const found = track.clips.find((c) => c.id === selectedClipId);
    if (found) {
      selectedClip = found;
      selectedTrackType = track.type;
      break;
    }
  }

  const selectedAsset = selectedClip
    ? project.assets.find((a) => a.id === selectedClip!.assetId) || null
    : null;

  // Add an asset from the Media Bin onto the appropriate timeline track at the playhead (or track end)
  const handlePlaceAssetOnTimeline = (asset: ProjectMediaAsset, mode: 'at-playhead' | 'append') => {
    onUpdateProject((prev) => {
      const next: VideoProjectManifest = JSON.parse(JSON.stringify(prev));
      let targetTrackType: TrackType = 'video';
      if (asset.kind === 'dialogue') targetTrackType = 'dialogue';
      else if (asset.kind === 'sfx') targetTrackType = 'sfx';
      else if (asset.kind === 'music') targetTrackType = 'music';

      const track = next.timeline.tracks.find((t) => t.type === targetTrackType);
      if (!track) return prev;

      const startSec =
        mode === 'at-playhead'
          ? Math.round(playhead * 20) / 20
          : track.clips.reduce(
              (max, c) => Math.max(max, c.timelineStart + (c.sourceOut - c.sourceIn)),
              0
            );

      track.clips.push({
        id: `clip_${asset.id}_${Date.now().toString().slice(-4)}`,
        assetId: asset.id,
        trackId: track.id,
        sceneId: asset.sceneId,
        label: asset.label,
        timelineStart: Math.round(startSec * 100) / 100,
        sourceIn: 0,
        sourceOut: asset.durationSeconds,
        volume: targetTrackType === 'music' ? 0.35 : 1.0,
        fadeIn: targetTrackType === 'music' ? 0.5 : 0,
        fadeOut: targetTrackType === 'music' ? 1.0 : 0,
        kenBurns: asset.kind === 'image' ? 'zoom-in' : 'none',
      });

      return next;
    });
  };

  const updateSelectedClipField = (patch: Partial<TimelineClip>) => {
    if (!selectedClipId) return;
    onUpdateProject((prev) => {
      const next: VideoProjectManifest = JSON.parse(JSON.stringify(prev));
      for (const track of next.timeline.tracks) {
        const clip = track.clips.find((c) => c.id === selectedClipId);
        if (clip) {
          Object.assign(clip, patch);
          break;
        }
      }
      return next;
    });
  };

  const getAssetIcon = (kind: MediaAssetKind) => {
    switch (kind) {
      case 'video':
        return <Film size={14} color="#60a5fa" />;
      case 'image':
        return <ImageIcon size={14} color="#fbbf24" />;
      case 'dialogue':
        return <Mic size={14} color="#34d399" />;
      case 'sfx':
        return <Sparkles size={14} color="#c084fc" />;
      case 'music':
        return <Music size={14} color="#f59e0b" />;
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isExpandedWidth ? 'row' : 'column',
        height: '100%',
        background: '#0b101d',
        overflow: 'hidden',
      }}
    >
      {/* Left / Upper Column: Media Bin (Import Bar + Category Tabs + Scrollable Asset List) */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: isExpandedWidth ? '62%' : '100%',
          height: isExpandedWidth ? '100%' : undefined,
          flex: isExpandedWidth ? undefined : 1,
          minHeight: 0,
          borderRight: isExpandedWidth ? '1px solid #1e293b' : 'none',
          overflow: 'hidden',
        }}
      >
        {/* Import Media Bar (Independent BGM / SFX / Video Import into assets/) */}
        <div
          style={{
            padding: '10px 12px',
            borderBottom: '1px solid #1e293b',
            background: '#0f1626',
            flexShrink: 0,
          }}
        >
        <div
          style={{
            fontSize: '11px',
            fontWeight: 600,
            color: '#94a3b8',
            marginBottom: '8px',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          Import Media into Project (Self-Contained)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '6px' }}>
          <button
            onClick={() => onImportMedia('dialogue')}
            style={importBtnStyle}
            title="Import Dialogue / Voiceover (Defaults to project audio/ folder)"
          >
            <Mic size={13} color="#34d399" />
            <span>+ Voiceover</span>
          </button>
          <button
            onClick={() => onImportMedia('music')}
            style={importBtnStyle}
            title="Import Backing Music (Defaults to project assets/audio/)"
          >
            <Music size={13} color="#f59e0b" />
            <span>+ Music</span>
          </button>
          <button
            onClick={() => onImportMedia('sfx')}
            style={importBtnStyle}
            title="Import Sound Effects (Defaults to project assets/audio/)"
          >
            <Sparkles size={13} color="#c084fc" />
            <span>+ SFX</span>
          </button>
          <button
            onClick={() => onImportMedia('video')}
            style={importBtnStyle}
            title="Import Video or Still Image (Defaults to project assets/images/ or assets/video/)"
          >
            <Upload size={13} color="#38bdf8" />
            <span>+ Video/Img</span>
          </button>
        </div>
      </div>

      {/* Category Filter Tabs */}
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid #1e293b',
          background: '#0c1220',
          padding: '0 8px',
        }}
      >
        {[
          { id: 'all', label: `All (${project.assets.length})` },
          { id: 'video', label: 'Scenes/Video' },
          { id: 'dialogue', label: 'Dialogue' },
          { id: 'sfx-bgm', label: 'BGM & SFX' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            style={{
              flex: 1,
              padding: '8px 4px',
              fontSize: '11px',
              fontWeight: activeTab === tab.id ? 600 : 400,
              color: activeTab === tab.id ? '#38bdf8' : '#94a3b8',
              background: 'transparent',
              border: 'none',
              borderBottom:
                activeTab === tab.id ? '2px solid #38bdf8' : '2px solid transparent',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Scrollable Asset Catalogue List */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        {filteredAssets.length === 0 ? (
          <div
            style={{
              padding: '24px 12px',
              textAlign: 'center',
              color: '#64748b',
              fontSize: '12px',
            }}
          >
            No media assets in this category yet. Click "+ Music", "+ SFX", or "+ Video/Img" above
            to import files into the project folder.
          </div>
        ) : (
          filteredAssets.map((asset) => {
            const isRecentlyImported = asset.id === lastImportedAssetId;
            return (
              <div
                key={asset.id}
                ref={(el) => {
                  if (el) assetRowRefs.current.set(asset.id, el);
                  else assetRowRefs.current.delete(asset.id);
                }}
                style={{
                  background: isRecentlyImported ? 'rgba(14, 116, 144, 0.28)' : '#131c2e',
                  border: isRecentlyImported ? '1px solid #38bdf8' : '1px solid #22304d',
                  boxShadow: isRecentlyImported ? '0 0 0 1px rgba(56, 189, 248, 0.35)' : 'none',
                  borderRadius: '6px',
                  padding: '8px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '12px',
                      fontWeight: 500,
                      color: '#e2e8f0',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {getAssetIcon(asset.kind)}
                    {isRecentlyImported && (
                      <span
                        style={{
                          fontSize: '9px',
                          padding: '1px 5px',
                          borderRadius: '3px',
                          background: '#0284c7',
                          color: '#fff',
                          fontWeight: 700,
                        }}
                      >
                        NEW
                      </span>
                    )}
                    <span title={asset.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {asset.label}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: '10px',
                      color: '#64748b',
                      marginTop: '3px',
                      display: 'flex',
                      gap: '8px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{ color: '#94a3b8' }}>{asset.durationSeconds.toFixed(1)}s</span>
                    <span title={asset.relativePath}>{asset.relativePath}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                  <button
                    onClick={() => handlePlaceAssetOnTimeline(asset, 'at-playhead')}
                    title="Place on timeline at current Playhead position"
                    style={placeBtnStyle}
                  >
                    <Plus size={12} />
                    <span>At Playhead</span>
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      </div>

      {/* Right / Lower Column: Selected Clip Inspector Panel */}
      <div
        style={{
          width: isExpandedWidth ? '38%' : '100%',
          height: isExpandedWidth ? '100%' : undefined,
          overflowY: isExpandedWidth ? 'auto' : undefined,
          borderTop: isExpandedWidth ? 'none' : '1px solid #1e293b',
          background: '#0f1626',
          padding: '10px 12px',
          minHeight: isExpandedWidth ? 0 : '175px',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '11px',
            fontWeight: 600,
            color: '#94a3b8',
            marginBottom: '8px',
            textTransform: 'uppercase',
          }}
        >
          <Sliders size={13} color="#38bdf8" />
          <span>Clip Inspector</span>
        </div>

        {!selectedClip ? (
          <div style={{ fontSize: '12px', color: '#64748b', paddingTop: '12px' }}>
            Click any clip on the timeline to inspect or fine-tune its start time, trim bounds,
            volume, or fades.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
            <div
              style={{
                fontWeight: 600,
                color: '#f8fafc',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {selectedClip.label}
            </div>

            {selectedAsset && (
              <div style={{ fontSize: '11px', color: '#38bdf8' }}>
                Path: {selectedAsset.relativePath}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
              <label style={inspectorFieldStyle}>
                <span>Timeline Start (s)</span>
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={selectedClip.timelineStart}
                  onChange={(e) =>
                    updateSelectedClipField({
                      timelineStart: Math.max(0, parseFloat(e.target.value) || 0),
                    })
                  }
                  style={inspectorInputStyle}
                />
              </label>

              <label style={inspectorFieldStyle}>
                <span>Source In (s)</span>
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={selectedClip.sourceIn}
                  onChange={(e) =>
                    updateSelectedClipField({
                      sourceIn: Math.max(0, parseFloat(e.target.value) || 0),
                    })
                  }
                  style={inspectorInputStyle}
                />
              </label>

              <label style={inspectorFieldStyle}>
                <span>Source Out (s)</span>
                <input
                  type="number"
                  step={0.1}
                  min={selectedClip.sourceIn + 0.2}
                  value={selectedClip.sourceOut}
                  onChange={(e) =>
                    updateSelectedClipField({
                      sourceOut: Math.max(
                        selectedClip!.sourceIn + 0.2,
                        parseFloat(e.target.value) || 1
                      ),
                    })
                  }
                  style={inspectorInputStyle}
                />
              </label>
            </div>

            {selectedTrackType === 'video' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' }}>
                <label style={inspectorFieldStyle}>
                  <span style={{ color: '#38bdf8', fontWeight: 600 }}>
                    Still Image / Camera Motion (Ken Burns Effect)
                  </span>
                  <select
                    value={selectedClip.kenBurns || 'none'}
                    onChange={(e) =>
                      updateSelectedClipField({
                        kenBurns: e.target.value as KenBurnsPreset,
                      })
                    }
                    style={{
                      ...inspectorInputStyle,
                      cursor: 'pointer',
                    }}
                  >
                    {(Object.keys(KEN_BURNS_PRESET_LABELS) as KenBurnsPreset[]).map((presetKey) => (
                      <option key={presetKey} value={presetKey}>
                        {KEN_BURNS_PRESET_LABELS[presetKey]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {selectedTrackType !== 'video' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
                  <label style={inspectorFieldStyle}>
                    <span>Clip Volume ({Math.round((selectedClip.volume ?? 1) * 100)}%)</span>
                    <input
                      type="range"
                      min={0}
                      max={1.5}
                      step={0.05}
                      value={selectedClip.volume ?? 1}
                      onChange={(e) =>
                        updateSelectedClipField({ volume: parseFloat(e.target.value) })
                      }
                    />
                  </label>

                  <label style={inspectorFieldStyle}>
                    <span>Fade In (s)</span>
                    <input
                      type="number"
                      step={0.1}
                      min={0}
                      value={selectedClip.fadeIn || 0}
                      onChange={(e) =>
                        updateSelectedClipField({
                          fadeIn: Math.max(0, parseFloat(e.target.value) || 0),
                        })
                      }
                      style={inspectorInputStyle}
                    />
                  </label>

                  <label style={inspectorFieldStyle}>
                    <span>Fade Out (s)</span>
                    <input
                      type="number"
                      step={0.1}
                      min={0}
                      value={selectedClip.fadeOut || 0}
                      onChange={(e) =>
                        updateSelectedClipField({
                          fadeOut: Math.max(0, parseFloat(e.target.value) || 0),
                        })
                      }
                      style={inspectorInputStyle}
                    />
                  </label>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px' }}>
                  <span style={{ color: '#94a3b8' }}>Fade Presets:</span>
                  <button
                    type="button"
                    onClick={() => updateSelectedClipField({ fadeIn: 0, fadeOut: 0 })}
                    style={placeBtnStyle}
                    title="Turn off Fade In and Fade Out on this clip"
                  >
                    No Fade (0s)
                  </button>
                  <button
                    type="button"
                    onClick={() => updateSelectedClipField({ fadeIn: 0.5, fadeOut: 1.0 })}
                    style={placeBtnStyle}
                    title="Standard Music Fade (0.5s In / 1.0s Out)"
                  >
                    Standard (0.5s / 1.0s)
                  </button>
                  <button
                    type="button"
                    onClick={() => updateSelectedClipField({ fadeIn: 2.0, fadeOut: 2.5 })}
                    style={placeBtnStyle}
                    title="Slow Cinematic Swell (2.0s In / 2.5s Out)"
                  >
                    Cinematic (2.0s / 2.5s)
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const importBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '5px',
  background: '#161f33',
  color: '#f1f5f9',
  border: '1px solid #283552',
  borderRadius: '5px',
  padding: '6px 8px',
  fontSize: '11px',
  fontWeight: 500,
};

const placeBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  background: '#1e293b',
  color: '#38bdf8',
  border: '1px solid #334155',
  borderRadius: '4px',
  padding: '4px 8px',
  fontSize: '11px',
};

const inspectorFieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '3px',
  fontSize: '10px',
  color: '#94a3b8',
};

const inspectorInputStyle: React.CSSProperties = {
  background: '#090d16',
  color: '#f1f5f9',
  border: '1px solid #283552',
  borderRadius: '4px',
  padding: '4px 6px',
  fontSize: '11px',
};
