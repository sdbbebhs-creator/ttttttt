import React, { useMemo, useState } from 'react';
import {
  Settings2,
  Target,
  CalendarRange,
  Timer,
  Cpu,
  RefreshCw,
  RotateCcw,
  ChevronDown,
  CheckCircle2,
} from 'lucide-react';
import { ReviewLog } from '../types';
import {
  getFSRSInstance,
  isValidLearningStep,
  learningStepToMinutes,
  DEFAULT_LIBRARY_WEIGHTS,
  DEFAULT_LEARNING_STEPS,
  DEFAULT_MAXIMUM_INTERVAL,
  MAXIMUM_INTERVAL_PRESETS,
  MIN_DESIRED_RETENTION,
  MAX_DESIRED_RETENTION,
  type FSRSSettings,
  type LearningStep,
} from '../utils/fsrs';
import {
  optimizeFSRSWeights,
  MIN_REVIEWS_FOR_OPTIMIZATION,
  RECOMMENDED_REVIEWS_FOR_OPTIMIZATION,
  type WeightsOptimizationResult,
} from '../utils/fsrsOptimizer';
import { useFSRSSettings } from '../hooks/useFSRSSettings';

/**
 * Bản nháp cài đặt trong Trợ Lý Đo Nhịp: chỉ được áp dụng (và lưu vào tài khoản)
 * khi bấm "Lưu cài đặt". Ô nhập giữ dạng chữ để người dùng gõ dở vẫn không bị mất.
 */
export interface FSRSSettingsDraft {
  /** Tỷ lệ ghi nhớ mục tiêu (%) */
  targetRetention: number;
  maxIntervalText: string;
  learningStepsEnabled: boolean;
  stepsText: string;
  customWeights: number[] | null;
  weightsOptimizedAt?: string;
  weightsReviewCount?: number;
}

const parseSteps = (input: string) =>
  input
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
const isValidMaxInterval = (value: number) => Number.isInteger(value) && value >= 1 && value <= 36500;

export function draftFromSettings(settings: FSRSSettings): FSRSSettingsDraft {
  return {
    targetRetention: Math.round(settings.targetRetention * 100),
    maxIntervalText: String(settings.maximumInterval),
    learningStepsEnabled: settings.learningStepsEnabled,
    stepsText: settings.learningSteps.join(' '),
    customWeights: settings.customWeights,
    weightsOptimizedAt: settings.weightsOptimizedAt,
    weightsReviewCount: settings.weightsReviewCount,
  };
}

/** Kiểm tra bản nháp; hợp lệ thì trả về phần cài đặt cần ghi. */
export function validateDraft(
  draft: FSRSSettingsDraft,
  saved: FSRSSettings
): { valid: true; patch: Partial<FSRSSettings> } | { valid: false; reason: string } {
  const maximumInterval = Number(draft.maxIntervalText);
  if (!isValidMaxInterval(maximumInterval)) {
    return { valid: false, reason: 'Khoảng cách tối đa phải là số ngày từ 1 đến 36.500.' };
  }
  const steps = parseSteps(draft.stepsText);
  const stepsValid = steps.length > 0 && steps.every(isValidLearningStep);
  if (draft.learningStepsEnabled && !stepsValid) {
    return { valid: false, reason: 'Bước học ban đầu chưa đúng định dạng (vd: 10m 30m).' };
  }
  return {
    valid: true,
    patch: {
      targetRetention: draft.targetRetention / 100,
      maximumInterval,
      learningStepsEnabled: draft.learningStepsEnabled,
      learningSteps: stepsValid ? (steps as LearningStep[]) : saved.learningSteps,
      customWeights: draft.customWeights,
      weightsOptimizedAt: draft.weightsOptimizedAt,
      weightsReviewCount: draft.weightsReviewCount,
    },
  };
}

/** Số mục trong bản nháp khác với cài đặt đang dùng */
export function countDraftChanges(draft: FSRSSettingsDraft, saved: FSRSSettings): number {
  let n = 0;
  if (draft.targetRetention !== Math.round(saved.targetRetention * 100)) n++;
  if (Number(draft.maxIntervalText) !== saved.maximumInterval) n++;
  if (draft.learningStepsEnabled !== saved.learningStepsEnabled) n++;
  else if (draft.learningStepsEnabled && parseSteps(draft.stepsText).join(' ') !== saved.learningSteps.join(' ')) n++;
  if (JSON.stringify(draft.customWeights ?? null) !== JSON.stringify(saved.customWeights ?? null)) n++;
  return n;
}

interface FSRSSettingsPanelProps {
  draft: FSRSSettingsDraft;
  onChange: (patch: Partial<FSRSSettingsDraft>) => void;
  reviewLogs: ReviewLog[];
  onShowToast: (msg: string) => void;
}

const STEP_PRESETS: { label: string; steps: LearningStep[] }[] = [
  { label: '10m', steps: ['10m'] },
  { label: '10m · 30m', steps: ['10m', '30m'] },
  { label: '1m · 10m', steps: ['1m', '10m'] },
  { label: '10m · 1h', steps: ['10m', '1h'] },
];

const sectionClass =
  'p-4 rounded-2xl bg-white dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/80 space-y-3';
const titleClass = 'font-bold text-slate-900 dark:text-slate-100 text-xs sm:text-sm flex items-center gap-1.5';
const hintClass = 'text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed';

function formatMinutes(minutes: number): string {
  if (minutes >= 1440) return `${Number((minutes / 1440).toFixed(1))} ngày`;
  if (minutes >= 60) return `${Number((minutes / 60).toFixed(1))} giờ`;
  return `${minutes} phút`;
}

export const FSRSSettingsPanel: React.FC<FSRSSettingsPanelProps> = ({ draft, onChange, reviewLogs, onShowToast }) => {
  // Mọi thay đổi chỉ nằm trong bản nháp của modal cha cho tới khi bấm "Lưu cài đặt".
  const saved = useFSRSSettings();
  const targetRetention = draft.targetRetention;
  const maxIntervalInput = draft.maxIntervalText;
  const stepsInput = draft.stepsText;
  const settings = {
    ...saved,
    customWeights: draft.customWeights,
    weightsOptimizedAt: draft.weightsOptimizedAt,
    weightsReviewCount: draft.weightsReviewCount,
    learningStepsEnabled: draft.learningStepsEnabled,
    maximumInterval: isValidMaxInterval(Number(draft.maxIntervalText)) ? Number(draft.maxIntervalText) : saved.maximumInterval,
  };

  const [optimizing, setOptimizing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [optResult, setOptResult] = useState<WeightsOptimizationResult | null>(null);
  const [optError, setOptError] = useState<string | null>(null);
  const [showWeights, setShowWeights] = useState(false);

  const reviewCount = reviewLogs.length;
  const activeWeights = settings.customWeights ?? DEFAULT_LIBRARY_WEIGHTS;

  // Ví dụ minh họa: thẻ có độ bền S = 10 ngày sẽ được ôn lại sau bao lâu
  const retentionExample = useMemo(() => {
    const f = getFSRSInstance(targetRetention / 100, {}, settings);
    return f.next_interval(10, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetRetention, settings.maximumInterval, settings.customWeights, saved]);

  const parsedSteps = parseSteps(stepsInput);
  const invalidSteps = parsedSteps.filter((s) => !isValidLearningStep(s));
  const maxIntervalValid = isValidMaxInterval(Number(maxIntervalInput));

  const handleMaxIntervalInput = (value: string) => onChange({ maxIntervalText: value });

  const handleStepsInput = (value: string) => onChange({ stepsText: value });

  const handleToggleLearningSteps = () => {
    const enable = !draft.learningStepsEnabled;
    // Bật lại khi ô nhập đang trống / sai -> dùng bộ bước mặc định để thẻ mới vẫn có bước ngắn
    if (enable && (parsedSteps.length === 0 || invalidSteps.length > 0)) {
      onChange({ learningStepsEnabled: true, stepsText: DEFAULT_LEARNING_STEPS.join(' ') });
      return;
    }
    onChange({ learningStepsEnabled: enable });
  };

  const handleOptimize = async () => {
    setOptimizing(true);
    setOptError(null);
    setOptResult(null);
    setProgress(0);
    try {
      const result = await optimizeFSRSWeights(reviewLogs, setProgress);
      setOptResult(result);
    } catch (err) {
      setOptError(err instanceof Error ? err.message : 'Không thể tối ưu tham số.');
    } finally {
      setOptimizing(false);
    }
  };

  const handleApplyWeights = () => {
    if (!optResult) return;
    onChange({
      customWeights: optResult.weights,
      weightsOptimizedAt: new Date().toISOString(),
      weightsReviewCount: optResult.reviewCount,
    });
    setOptResult(null);
    onShowToast('🧠 Đã chọn bộ tham số riêng — bấm “Lưu cài đặt” để áp dụng.');
  };

  const handleResetWeights = () => {
    onChange({
      customWeights: null,
      weightsOptimizedAt: undefined,
      weightsReviewCount: undefined,
    });
    onShowToast('Đã chọn bộ tham số tiêu chuẩn — bấm “Lưu cài đặt” để áp dụng.');
  };

  const optimizeProgressPercent = Math.min(100, Math.round((reviewCount / RECOMMENDED_REVIEWS_FOR_OPTIMIZATION) * 100));
  const canOptimize = reviewCount >= MIN_REVIEWS_FOR_OPTIMIZATION;

  return (
    <div id="fsrs-settings-panel" className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-black text-slate-900 dark:text-slate-100 text-xs sm:text-sm flex items-center gap-1.5">
          <Settings2 size={16} className="text-teal-500" />
          3. Cài Đặt Thuật Toán FSRS
        </span>
        <span className="text-[10px] font-bold text-slate-400">Bấm “Lưu cài đặt” để áp dụng</span>
      </div>

      {/* Tỷ lệ ghi nhớ mục tiêu */}
      <div className={sectionClass}>
        <div className="flex items-center justify-between">
          <span className={titleClass}>
            <Target size={15} className="text-indigo-500" />
            Tỷ lệ ghi nhớ mục tiêu (Desired Retention)
          </span>
          <span className="text-base font-black text-indigo-600 dark:text-indigo-400">{targetRetention}%</span>
        </div>
        <input
          type="range"
          min={Math.round(MIN_DESIRED_RETENTION * 100)}
          max={Math.round(MAX_DESIRED_RETENTION * 100)}
          step={1}
          value={targetRetention}
          onChange={(e) => onChange({ targetRetention: Number(e.target.value) })}
          className="w-full accent-indigo-600 cursor-pointer"
          aria-label="Tỷ lệ ghi nhớ mục tiêu"
        />
        <div className="flex justify-between text-[10px] font-semibold text-slate-400">
          <span>80% · Tiết kiệm thời gian</span>
          <span>95% · Nhớ rất chắc</span>
        </div>
        <p className={hintClass}>
          Mục tiêu càng cao, lịch ôn càng dày; chọn 80%–85% để khoảng cách giữa các lần ôn dài hơn. Ví dụ: một thẻ có độ bền
          10 ngày sẽ được hẹn ôn lại sau <strong className="text-slate-700 dark:text-slate-200">{retentionExample} ngày</strong>.
        </p>
      </div>

      {/* Khoảng cách tối đa */}
      <div className={sectionClass}>
        <span className={titleClass}>
          <CalendarRange size={15} className="text-amber-500" />
          Khoảng cách tối đa (Maximum Interval)
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {MAXIMUM_INTERVAL_PRESETS.map((days) => {
            const active = Number(maxIntervalInput) === days;
            return (
              <button
                key={days}
                type="button"
                onClick={() => handleMaxIntervalInput(String(days))}
                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-colors cursor-pointer ${
                  active
                    ? 'bg-amber-500 border-amber-500 text-white'
                    : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-amber-400'
                }`}
              >
                {days.toLocaleString('vi-VN')} ngày
              </button>
            );
          })}
          <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
            Tùy chỉnh:
            <input
              type="number"
              min={1}
              max={36500}
              value={maxIntervalInput}
              onChange={(e) => handleMaxIntervalInput(e.target.value)}
              className={`w-20 px-2 py-1 rounded-lg border bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-xs font-bold ${
                maxIntervalValid ? 'border-slate-200 dark:border-slate-700' : 'border-rose-400'
              }`}
            />
            ngày
          </label>
        </div>
        <p className={hintClass}>
          Giới hạn số ngày tối đa một thẻ được giãn ra, kể cả khi bạn đã nhớ rất chắc. Mặc định{' '}
          {DEFAULT_MAXIMUM_INTERVAL} ngày.
        </p>
      </div>

      {/* Bước học ban đầu */}
      <div className={sectionClass}>
        <div className="flex items-center justify-between gap-2">
          <span className={titleClass}>
            <Timer size={15} className="text-rose-500" />
            Bước học ban đầu (Learning Steps)
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={settings.learningStepsEnabled}
            onClick={handleToggleLearningSteps}
            className={`relative w-10 h-6 rounded-full transition-colors cursor-pointer shrink-0 ${
              settings.learningStepsEnabled ? 'bg-rose-500' : 'bg-slate-300 dark:bg-slate-600'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                settings.learningStepsEnabled ? 'translate-x-4' : ''
              }`}
            />
          </button>
        </div>
        <p className={hintClass}>
          Khi bật, thẻ mới hoàn toàn sẽ được ôn lại sau các khoảng ngắn (vd: 10 phút, 30 phút) ngay trong ngày trước khi
          chính thức chuyển sang lịch FSRS tính theo ngày. Khi tắt, thẻ mới được lên lịch theo ngày ngay từ lần đầu.
        </p>
        {settings.learningStepsEnabled && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {STEP_PRESETS.map((preset) => {
                const active = parsedSteps.join(' ') === preset.steps.join(' ');
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => handleStepsInput(preset.steps.join(' '))}
                    className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-colors cursor-pointer ${
                      active
                        ? 'bg-rose-500 border-rose-500 text-white'
                        : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-rose-400'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
            <input
              type="text"
              value={stepsInput}
              onChange={(e) => handleStepsInput(e.target.value)}
              placeholder={DEFAULT_LEARNING_STEPS.join(' ')}
              className={`w-full px-3 py-2 rounded-lg border bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-xs font-mono ${
                invalidSteps.length > 0 ? 'border-rose-400' : 'border-slate-200 dark:border-slate-700'
              }`}
              aria-label="Các bước học ban đầu"
            />
            {invalidSteps.length > 0 ? (
              <p className="text-[11px] text-rose-600 dark:text-rose-400">
                Không hiểu: {invalidSteps.join(', ')}. Dùng định dạng số + m (phút), h (giờ) hoặc d (ngày).
              </p>
            ) : (
              parsedSteps.length > 0 && (
                <p className={hintClass}>
                  Thẻ mới → {parsedSteps.map((s) => formatMinutes(learningStepToMinutes(s as LearningStep))).join(' → ')} →
                  lịch FSRS theo ngày.
                </p>
              )
            )}
          </div>
        )}
      </div>

      {/* Tập tham số riêng */}
      <div className={sectionClass}>
        <div className="flex items-center justify-between gap-2">
          <span className={titleClass}>
            <Cpu size={15} className="text-emerald-500" />
            Tập tham số riêng (Weights / Parameters)
          </span>
          <span
            className={`text-[10px] font-black px-2 py-0.5 rounded-md border ${
              settings.customWeights
                ? 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-300'
                : 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
            }`}
          >
            {settings.customWeights ? 'Đang dùng bộ riêng' : 'Bộ tiêu chuẩn'}
          </span>
        </div>
        <p className={hintClass}>
          FSRS dùng {DEFAULT_LIBRARY_WEIGHTS.length} tham số toán học để vẽ đường cong quên. Ban đầu hệ thống dùng bộ tiêu
          chuẩn; khi bạn ôn được vài trăm đến 1.000 lượt, bộ tối ưu sẽ phân tích lịch sử học của riêng bạn để điều chỉnh các
          tham số cho khớp với tốc độ ghi nhớ của bạn.
        </p>

        {settings.customWeights && settings.weightsOptimizedAt && (
          <p className="text-[11px] text-emerald-700 dark:text-emerald-400 font-semibold">
            Tối ưu lúc {new Date(settings.weightsOptimizedAt).toLocaleString('vi-VN')} từ{' '}
            {settings.weightsReviewCount?.toLocaleString('vi-VN')} lượt ôn.
          </p>
        )}

        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px] text-slate-500 dark:text-slate-400">
            <span>
              Lịch sử đã lưu: <strong>{reviewCount.toLocaleString('vi-VN')}</strong> lượt
            </span>
            <span>
              Tối thiểu {MIN_REVIEWS_FOR_OPTIMIZATION} · khuyến nghị {RECOMMENDED_REVIEWS_FOR_OPTIMIZATION.toLocaleString('vi-VN')}
            </span>
          </div>
          <div className="w-full bg-slate-200 dark:bg-slate-700 h-2 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${
                reviewCount >= RECOMMENDED_REVIEWS_FOR_OPTIMIZATION
                  ? 'bg-emerald-500'
                  : canOptimize
                  ? 'bg-teal-500'
                  : 'bg-amber-400'
              }`}
              style={{ width: `${optimizeProgressPercent}%` }}
            />
          </div>
          {canOptimize && reviewCount < RECOMMENDED_REVIEWS_FOR_OPTIMIZATION && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              Đã đủ dữ liệu để tối ưu, nhưng kết quả sẽ chính xác hơn khi đạt 1.000 lượt.
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleOptimize}
            disabled={!canOptimize || optimizing}
            className="flex-1 min-w-[180px] py-2 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw size={14} className={optimizing ? 'animate-spin' : ''} />
            {optimizing
              ? `Đang phân tích lịch sử... ${Math.round(progress * 100)}%`
              : canOptimize
              ? 'Tối ưu tham số từ lịch sử của tôi'
              : `Cần thêm ${MIN_REVIEWS_FOR_OPTIMIZATION - reviewCount} lượt ôn`}
          </button>
          {settings.customWeights && (
            <button
              type="button"
              onClick={handleResetWeights}
              className="py-2 px-3 rounded-xl font-semibold text-xs flex items-center justify-center gap-1.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-200 transition-colors cursor-pointer"
            >
              <RotateCcw size={13} />
              Dùng bộ tiêu chuẩn
            </button>
          )}
        </div>

        {optimizing && (
          <div className="w-full bg-slate-200 dark:bg-slate-700 h-1.5 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}

        {optError && <p className="text-[11px] text-rose-600 dark:text-rose-400">{optError}</p>}

        {optResult && (
          <div className="p-3 rounded-xl bg-emerald-50/80 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 space-y-2 animate-fade-in">
            <p className="text-xs text-emerald-900 dark:text-emerald-200 leading-relaxed">
              Đã phân tích <strong>{optResult.reviewCount.toLocaleString('vi-VN')}</strong> lượt ôn của{' '}
              <strong>{optResult.itemCount}</strong> thẻ. Sai số dự đoán (log-loss): {optResult.lossBefore} →{' '}
              <strong>{optResult.lossAfter}</strong>{' '}
              {optResult.improvementPercent > 0
                ? `(chính xác hơn ${optResult.improvementPercent}%)`
                : '(bộ tiêu chuẩn đã khá phù hợp với bạn)'}
              .
            </p>
            <button
              type="button"
              onClick={handleApplyWeights}
              disabled={optResult.improvementPercent <= 0}
              className="w-full py-2 px-3 rounded-lg font-bold text-xs flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle2 size={14} />
              Chọn bộ tham số riêng
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => setShowWeights((v) => !v)}
          className="text-[11px] font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 flex items-center gap-1 cursor-pointer"
        >
          <ChevronDown size={13} className={`transition-transform ${showWeights ? 'rotate-180' : ''}`} />
          {showWeights ? 'Ẩn' : 'Xem'} {activeWeights.length} tham số đang dùng
        </button>
        {showWeights && (
          <div className="grid grid-cols-3 sm:grid-cols-7 gap-1.5 font-mono text-[10px]">
            {activeWeights.map((value, i) => {
              const changed = !!settings.customWeights && Math.abs(value - DEFAULT_LIBRARY_WEIGHTS[i]) > 1e-4;
              return (
                <div
                  key={i}
                  className={`px-1.5 py-1 rounded-md border text-center ${
                    changed
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 text-emerald-800 dark:text-emerald-300'
                      : 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                  }`}
                  title={changed ? `Mặc định: ${DEFAULT_LIBRARY_WEIGHTS[i]}` : undefined}
                >
                  <span className="text-slate-400">w{i}</span> {value.toFixed(4)}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
