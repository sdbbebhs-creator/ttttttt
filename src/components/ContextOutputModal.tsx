import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Sparkles,
  CheckCircle2,
  Check,
  Flame,
  ChevronRight,
  ChevronLeft,
  Volume2,
  MessageSquare,
  Briefcase,
  GraduationCap,
  Laptop,
  Smile,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Wand2,
} from 'lucide-react';
import { VocabItem, GrammarItem, ReviewRating } from '../types';
import { AudioPlayerButton } from './AudioPlayerButton';
import { previewNextFSRSIntervals } from '../utils/fsrs';
import { useFSRSSettings } from '../hooks/useFSRSSettings';
import {
  generateFiveContextsAndSamples,
  generateSampleSentence,
  validateUserSentence,
  DEFAULT_CONTEXTS,
  PracticeApiError,
  SampleSentence,
  SentenceValidation,
} from '../utils/geminiPractice';

interface ContextOutputModalProps {
  isOpen: boolean;
  item: VocabItem | GrammarItem | null;
  itemKind?: 'vocab' | 'grammar';
  onClose: () => void;
  onCompleteContexts: (itemId: string, outputs: Record<number, string>, kind: 'vocab' | 'grammar') => void;
  onRateVocab?: (id: string, rating: ReviewRating, bypassGate?: boolean) => void;
  onRateGrammar?: (id: string, rating: ReviewRating, bypassGate?: boolean) => void;
  todayDate: string;
}

// Icon xoay vòng cho 5 tab ngữ cảnh động (tên ngữ cảnh do Gemini gợi ý)
const CONTEXT_ICONS = [MessageSquare, Briefcase, GraduationCap, Laptop, Smile];
const STEPS = [1, 2, 3, 4, 5];

type ValidationEntry = SentenceValidation & { fromAI: boolean };

export const ContextOutputModal: React.FC<ContextOutputModalProps> = ({
  isOpen,
  item,
  itemKind,
  onClose,
  onCompleteContexts,
  onRateVocab,
  onRateGrammar,
  todayDate,
}) => {
  const isGrammar = Boolean(item && ('formula' in item || itemKind === 'grammar'));
  const vocabItem = isGrammar ? null : (item as VocabItem | null);
  const grammarItem = isGrammar ? (item as GrammarItem | null) : null;
  const currentKind: 'vocab' | 'grammar' = isGrammar ? 'grammar' : 'vocab';

  const [activeStep, setActiveStep] = useState<number>(1);
  const [userOutputs, setUserOutputs] = useState<Record<number, string>>(() => item?.contextOutputs || {});
  const [completedStatus, setCompletedStatus] = useState<Record<number, boolean>>({});

  // Ngữ cảnh động (null = đang tải → hiển thị skeleton)
  const [contexts, setContexts] = useState<string[] | null>(null);
  const [contextsFromAI, setContextsFromAI] = useState(false);
  // 5 câu mẫu được trả về cùng 1 lần gọi Gemini và lưu cache theo tab
  const [samples, setSamples] = useState<Record<number, SampleSentence>>({});
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleNotice, setSampleNotice] = useState<string | null>(null);
  // Kết quả chấm điểm theo từng tab
  const [validations, setValidations] = useState<Record<number, ValidationEntry>>({});
  const [validating, setValidating] = useState(false);
  const [validateNotice, setValidateNotice] = useState<string | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef(0);

  const targetText = (isGrammar ? grammarItem?.title : vocabItem?.word) || '';
  const definitionText = isGrammar
    ? [grammarItem?.formula, grammarItem?.explanation].filter(Boolean).join(' — ')
    : vocabItem?.meaning || '';

  // Lock body scroll while modal is open
  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  // Support closing with Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Auto scroll to top of context modal whenever activeStep changes
  useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [activeStep]);

  // Reset và nạp trạng thái khi mở modal hoặc đổi item
  useEffect(() => {
    if (!item || !isOpen) return;
    setActiveStep(1);
    const existingOutputs = item.contextOutputs || {};
    setUserOutputs(existingOutputs);

    const initialStatus: Record<number, boolean> = {};
    for (let i = 1; i <= 5; i++) {
      if (existingOutputs[i] && existingOutputs[i].trim().length > 0) {
        initialStatus[i] = true;
      }
    }
    if ((item.completedContextsCount ?? 0) >= 5) {
      for (let i = 1; i <= 5; i++) initialStatus[i] = true;
    }
    setCompletedStatus(initialStatus);
    setSamples({});
    setValidations({});
    setSampleNotice(null);
    setValidateNotice(null);
    setSampleLoading(false);
    setValidating(false);
  }, [item?.id, isOpen]);

  // BƯỚC 1: Mở thẻ → MỘT lần gọi Gemini tạo luôn 5 ngữ cảnh + 5 câu mẫu tham khảo.
  useEffect(() => {
    if (!item || !isOpen || !targetText) return;
    const session = ++sessionRef.current;
    setContexts(null);
    setContextsFromAI(false);
    setSamples({});
    setSampleLoading(true);
    setSampleNotice(null);

    generateFiveContextsAndSamples(targetText, definitionText, currentKind).then(({ practice, fromAI }) => {
      if (sessionRef.current !== session) return;
      setContexts(practice.contexts);
      setSamples({
        1: practice.samples[0],
        2: practice.samples[1],
        3: practice.samples[2],
        4: practice.samples[3],
        5: practice.samples[4],
      });
      setContextsFromAI(fromAI);
      if (!fromAI) {
        setSampleNotice('AI đang bận — dùng bộ 5 ngữ cảnh và câu mẫu có sẵn, không gọi thêm AI.');
      }
      setActiveStep(1);
    }).finally(() => {
      if (sessionRef.current === session) setSampleLoading(false);
    });
  }, [item?.id, isOpen]);

  // Đổi câu mẫu: đây là lần gọi AI riêng, không ảnh hưởng tới lần tải ban đầu.
  const loadSample = async (step: number, avoid?: string) => {
    if (!contexts) return;
    const session = sessionRef.current;
    setSampleLoading(true);
    setSampleNotice(null);
    try {
      const sample = await generateSampleSentence(targetText, contexts[step - 1], currentKind, avoid);
      if (sessionRef.current !== session) return;
      setSamples((prev) => ({ ...prev, [step]: sample }));
    } catch (err) {
      if (sessionRef.current !== session) return;
      const rateLimited = err instanceof PracticeApiError && err.isRateLimit;
      setSampleNotice(
        rateLimited
          ? 'Gemini đang giới hạn lượt gọi (429). Tạm giữ câu mẫu hiện tại; thử lại sau.'
          : 'Không tạo được câu mẫu mới bằng AI, đang giữ câu mẫu hiện tại.'
      );
    } finally {
      setTimeout(() => {
        if (sessionRef.current === session) setSampleLoading(false);
      }, 250);
    }
  };

  // Không tự gọi AI khi chuyển tab: 5 câu mẫu đã được tạo trong lần batch đầu tiên.

  const completedCount = useMemo(() => {
    return Object.values(completedStatus).filter(Boolean).length;
  }, [completedStatus]);

  const isAllCompleted = completedCount >= 5;

  const currentSentence = userOutputs[activeStep] || '';

  // Tính trước các mốc FSRS (tính lại khi cài đặt FSRS thay đổi)
  const fsrsSettings = useFSRSSettings();
  const fsrsPreviews = useMemo(() => {
    if (!item) {
      return {
        1: { label: '+1 ngày' },
        2: { label: '+2 ngày' },
        3: { label: '+4 ngày' },
        4: { label: '+7 ngày' },
      };
    }
    return previewNextFSRSIntervals(item, new Date(), fsrsSettings);
  }, [item, fsrsSettings]);

  if (!isOpen || !item) return null;

  const currentContextName = contexts?.[activeStep - 1] || DEFAULT_CONTEXTS[activeStep - 1];
  const CurrentIcon = CONTEXT_ICONS[activeStep - 1] || MessageSquare;
  const currentSampleData = samples[activeStep];
  const currentSample = currentSampleData?.english || '';
  const currentValidation = validations[activeStep];
  const isBusy = sampleLoading || validating || !contexts;

  // Cập nhật text trong ô gõ (sửa câu → bỏ kết quả chấm cũ của tab này)
  const handleTextChange = (text: string) => {
    setUserOutputs((prev) => ({
      ...prev,
      [activeStep]: text,
    }));
    if (validations[activeStep]) {
      setValidations((prev) => {
        const next = { ...prev };
        delete next[activeStep];
        return next;
      });
    }
    setValidateNotice(null);
  };

  // Nút nhanh: Dùng câu mẫu
  const handleUseSample = () => {
    if (currentSample) handleTextChange(currentSample);
  };

  // Nút "Đổi câu mẫu" — bị khóa khi đang tải để tránh gọi API liên tục
  const handleRefreshSample = () => {
    if (sampleLoading || !contexts) return;
    loadSample(activeStep, samples[activeStep]?.english);
  };

  const handleSelectStep = (step: number) => {
    if (step === activeStep || isBusy) return;
    setValidateNotice(null);
    setActiveStep(step);
  };

  // Đánh dấu hoàn thành 1 ngữ cảnh và lưu câu
  const markStepDone = (text: string, jumpNext: boolean) => {
    const updatedStatus = {
      ...completedStatus,
      [activeStep]: true,
    };
    setCompletedStatus(updatedStatus);

    const updatedOutputs = {
      ...userOutputs,
      [activeStep]: text,
    };
    setUserOutputs(updatedOutputs);

    onCompleteContexts(item.id, updatedOutputs, currentKind);

    // Tự động nhảy sang bước chưa hoàn thành tiếp theo
    if (jumpNext && Object.values(updatedStatus).filter(Boolean).length < 5) {
      const nextId = STEPS.find((id) => !updatedStatus[id]);
      if (nextId) setActiveStep(nextId);
    }
  };

  // Luyện nói: không cần chấm điểm
  const handleMarkSpoken = () => {
    markStepDone(currentSentence.trim() || currentSample || 'Đã hoàn thành', true);
  };

  // BƯỚC 3: Xác nhận → Gemini chấm điểm, sửa ngữ pháp, nhận xét
  const handleConfirmStep = async () => {
    const sentence = currentSentence.trim();
    if (!sentence) {
      setValidateNotice(`Hãy gõ 1 câu tiếng Anh với "${targetText}" trước khi bấm Xác nhận nhé.`);
      return;
    }
    if (validating) return;
    const session = sessionRef.current;
    const step = activeStep;
    setValidating(true);
    setValidateNotice(null);
    try {
      const { result, fromAI, error } = await validateUserSentence(
        targetText,
        currentContextName,
        sentence,
        currentKind,
        grammarItem?.formula
      );
      if (sessionRef.current !== session) return;
      setValidations((prev) => ({ ...prev, [step]: { ...result, fromAI } }));
      if (!fromAI) {
        setValidateNotice(
          error?.isRateLimit
            ? 'Gemini đang giới hạn lượt gọi (429) — đây là kết quả chấm nhanh offline. Thử lại sau ít giây để AI chấm chi tiết.'
            : 'AI tạm thời không phản hồi — đây là kết quả chấm nhanh offline.'
        );
      }
      markStepDone(sentence, false);
    } finally {
      if (sessionRef.current === session) setValidating(false);
    }
  };

  // Đánh giá và lưu lịch FSRS
  const handleRate = (rating: ReviewRating) => {
    // Lưu các câu đã gõ trước khi đánh giá
    if (currentSentence.trim()) {
      const updatedOutputs = {
        ...userOutputs,
        [activeStep]: currentSentence.trim(),
      };
      onCompleteContexts(item.id, updatedOutputs, currentKind);
    }
    if (isGrammar && onRateGrammar) {
      onRateGrammar(item.id, rating, isAllCompleted);
    } else if (vocabItem && onRateVocab) {
      onRateVocab(item.id, rating, isAllCompleted);
    }
    onClose();
  };


  if (!isOpen || !item) return null;

  return createPortal(
    <div
      id="modal-context-output"
      className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-3xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden m-auto flex flex-col max-h-[calc(100dvh-1.5rem)] sm:max-h-[90vh]">
        {/* HEADER: THÔNG TIN TỪ VỰNG / NGỮ PHÁP */}
        <div className="px-5 py-4 sm:px-7 sm:py-5 bg-gradient-to-r from-emerald-600 via-teal-600 to-indigo-600 text-white flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <span className="text-[11px] uppercase tracking-wider font-bold text-emerald-200">
              Luyện Output 5 Lần ({isGrammar ? 'Ngữ pháp' : 'Từ vựng'})
            </span>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <h2 className="text-xl sm:text-2xl font-black truncate">
                {isGrammar ? grammarItem?.title : vocabItem?.word}
              </h2>
              {vocabItem?.phonetic && (
                <span className="text-xs font-mono text-emerald-100/90">{vocabItem.phonetic}</span>
              )}
              {vocabItem && (
                <AudioPlayerButton audioUrl={vocabItem.audioUrl} fallbackText={vocabItem.word} size="sm" />
              )}
            </div>
            <p className="text-xs sm:text-sm text-emerald-50/90 font-medium line-clamp-2 mt-1 leading-relaxed">
              {isGrammar ? `Công thức: ${grammarItem?.formula}` : `Nghĩa: ${vocabItem?.meaning}`}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-2 text-white/80 hover:text-white hover:bg-white/15 rounded-xl transition-colors cursor-pointer shrink-0"
            title="Đóng"
          >
            <X size={20} />
          </button>
        </div>

        {/* THANH ĐIỀU HƯỚNG 5 BƯỚC OUTPUT */}
        <div className="px-4 py-3.5 sm:px-7 sm:py-4 bg-slate-50 dark:bg-slate-850 border-b border-slate-100 dark:border-slate-800 shrink-0 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 min-w-0 text-xs sm:text-sm font-semibold text-slate-700 dark:text-slate-200">
              <Flame size={16} className="text-amber-500 fill-amber-400 shrink-0" />
              <span className="truncate">Dùng 1 {isGrammar ? 'cấu trúc' : 'từ'} trong 5 ngữ cảnh khác nhau</span>
            </span>
            <span className="shrink-0 text-xs font-bold tabular-nums text-amber-700 dark:text-amber-300 bg-amber-100/80 dark:bg-amber-900/40 px-2.5 py-1 rounded-full">
              {completedCount}/5 xong
            </span>
          </div>
          {!contexts ? (
            // Skeleton trong lúc Gemini gợi ý ngữ cảnh
            <div className="grid grid-cols-5 gap-2" aria-busy="true" aria-label="Đang tải ngữ cảnh">
              {STEPS.map((id) => (
                <div
                  key={id}
                  className="py-2.5 px-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 flex flex-col items-center gap-1.5 animate-pulse"
                >
                  <div className="w-4 h-4 rounded-full bg-slate-200 dark:bg-slate-700" />
                  <div className="h-2 w-8 rounded bg-slate-200 dark:bg-slate-700" />
                  <div className="h-2 w-12 rounded bg-slate-100 dark:bg-slate-700/70" />
                </div>
              ))}
            </div>
          ) : (
          <div className="grid grid-cols-5 gap-2">
            {contexts.map((name, idx) => {
              const id = idx + 1;
              const isDone = completedStatus[id];
              const isActive = activeStep === id;
              const Icon = CONTEXT_ICONS[idx] || MessageSquare;

              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => handleSelectStep(id)}
                  disabled={isBusy && !isActive}
                  title={name}
                  className={`min-h-[4.5rem] py-2.5 px-1.5 rounded-xl border flex flex-col items-center justify-start gap-1 transition-all cursor-pointer text-center relative disabled:cursor-wait disabled:opacity-60 ${
                    isActive
                      ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-500 text-emerald-900 dark:text-emerald-200 ring-2 ring-emerald-500/20'
                      : isDone
                      ? 'bg-white dark:bg-slate-800 border-emerald-300 dark:border-emerald-800 text-slate-700 dark:text-slate-300'
                      : 'bg-white dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 text-slate-400'
                  }`}
                >
                  <span className="flex items-center gap-1 text-[11px] font-bold">
                    {isDone ? (
                      <CheckCircle2 size={14} className="text-emerald-500 shrink-0 fill-emerald-100 dark:fill-emerald-950" />
                    ) : (
                      <Icon size={14} className={isActive ? 'text-emerald-600' : 'text-slate-400'} />
                    )}
                    <span className="hidden sm:inline">Lần</span> {id}
                  </span>
                  <span className="text-[10px] sm:text-[11px] leading-tight text-slate-500 dark:text-slate-400 line-clamp-2 w-full break-words">
                    {name}
                  </span>
                </button>
              );
            })}
          </div>
          )}

          {contexts && (
            <p className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
              {contextsFromAI ? (
                <>
                  <Wand2 size={11} className="text-emerald-500" />
                  Ngữ cảnh được Gemini gợi ý riêng cho {isGrammar ? 'cấu trúc' : 'từ'} này
                </>
              ) : (
                <>
                  <AlertTriangle size={11} className="text-amber-500" />
                  AI đang bận — dùng 5 ngữ cảnh mặc định
                </>
              )}
            </p>
          )}

          {/* Progress bar */}
          <div className="w-full bg-slate-200 dark:bg-slate-700 h-1.5 rounded-full overflow-hidden">
            <div
              className="bg-emerald-500 h-full transition-all duration-300"
              style={{ width: `${(completedCount / 5) * 100}%` }}
            />
          </div>
        </div>

        {/* NỘI DUNG CHÍNH: Ô GÕ VÀ CÂU MẪU CỦA NGỮ CẢNH ĐANG CHỌN */}
        <div ref={scrollContainerRef} className="px-4 py-5 sm:px-7 sm:py-6 overflow-y-auto overscroll-contain flex-1 min-h-0 space-y-6">
          {/* Thông tin ngữ cảnh */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <span className="p-2 bg-emerald-100 dark:bg-emerald-500/20 rounded-xl text-emerald-700 dark:text-emerald-300 shrink-0">
                <CurrentIcon size={18} />
              </span>
              <div className="min-w-0 space-y-0.5">
                <h3 className="font-bold text-slate-900 dark:text-slate-100 text-base sm:text-lg leading-snug">
                  Ngữ cảnh {activeStep}: {contexts ? currentContextName : 'Đang phân tích…'}
                </h3>
                <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                  Đặt 1 câu dùng “{targetText}” trong bối cảnh này
                </p>
              </div>
            </div>

            {completedStatus[activeStep] && (
              <span className="shrink-0 px-2.5 py-1 text-xs font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-950/60 rounded-full border border-emerald-300 dark:border-emerald-800 flex items-center gap-1">
                <Check size={14} strokeWidth={3} />
                Đã xong lần này
              </span>
            )}
          </div>

          {/* Câu mẫu gợi ý (Gemini sinh theo ngữ cảnh) */}
          <div className="p-4 sm:p-5 rounded-2xl bg-emerald-50/60 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-900/40 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs font-bold uppercase tracking-wide text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
                <Sparkles size={14} className="text-amber-500" />
                Câu mẫu tham khảo
              </span>
              <div className="flex items-center gap-2">
                {currentSample && <AudioPlayerButton fallbackText={currentSample} size="sm" />}
                <button
                  type="button"
                  onClick={handleRefreshSample}
                  disabled={isBusy}
                  className="h-8 px-3 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 rounded-lg transition-colors cursor-pointer border border-slate-300/60 dark:border-slate-600 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Sinh câu mẫu khác"
                >
                  <RefreshCw size={12} className={sampleLoading ? 'animate-spin' : ''} />
                  Đổi câu mẫu
                </button>
                <button
                  type="button"
                  onClick={handleUseSample}
                  disabled={!currentSample || sampleLoading}
                  className="h-8 px-3 text-xs font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 rounded-lg transition-colors cursor-pointer border border-emerald-300/60 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Dùng câu này
                </button>
              </div>
            </div>
            {sampleLoading || !currentSample ? (
              <div className="space-y-2.5 animate-pulse py-1" aria-busy="true">
                <div className="h-3 rounded bg-emerald-100 dark:bg-emerald-900/40 w-11/12" />
                <div className="h-3 rounded bg-emerald-100 dark:bg-emerald-900/40 w-3/4" />
                <div className="h-2.5 rounded bg-slate-100 dark:bg-slate-800 w-2/3" />
              </div>
            ) : (
              <>
                <p className="text-[15px] sm:text-base font-medium text-slate-800 dark:text-slate-100 leading-relaxed">
                  “{currentSample}”
                </p>
                {currentSampleData?.vietnamese && (
                  <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 leading-relaxed pl-3 border-l-2 border-emerald-200 dark:border-emerald-800">
                    {currentSampleData.vietnamese}
                  </p>
                )}
              </>
            )}
            {sampleNotice && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                {sampleNotice}
              </p>
            )}
          </div>

          {/* Ô nhập câu output của bạn */}
          <div className="space-y-2">
            <label className="font-semibold text-slate-800 dark:text-slate-200 text-sm flex items-center justify-between gap-2">
              <span>Câu của bạn với “{isGrammar ? grammarItem?.title : vocabItem?.word}”</span>
              {currentSentence.trim().length > 0 && (
                <span className="text-xs text-emerald-600 font-semibold flex items-center gap-1">
                  <CheckCircle2 size={13} />
                  Sẵn sàng
                </span>
              )}
            </label>
            <textarea
              value={currentSentence}
              onChange={(e) => handleTextChange(e.target.value)}
              disabled={validating}
              placeholder={`Nhập 1 câu tiếng Anh trong ngữ cảnh ${currentContextName.toLowerCase()}...`}
              rows={4}
              className="w-full px-4 py-3 text-[15px] sm:text-base rounded-2xl resize-y min-h-[7rem] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500 focus:outline-none transition-all shadow-inner leading-relaxed"
            />
          </div>

          {/* 2 Nút hành động nhanh gọn */}
          <div className="flex items-center justify-between gap-3 flex-wrap -mt-2">
            <button
              type="button"
              onClick={handleMarkSpoken}
              disabled={validating}
              className="h-10 px-4 text-xs sm:text-sm font-semibold disabled:opacity-50 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl transition-colors cursor-pointer"
            >
              Đã đọc to / Luyện âm bằng miệng
            </button>

            <button
              type="button"
              onClick={handleConfirmStep}
              disabled={validating || !contexts}
              className="h-11 px-6 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 active:scale-95 rounded-xl shadow-md transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-60 disabled:cursor-wait disabled:active:scale-100"
            >
              {validating ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
              <span>{validating ? 'AI đang chấm…' : `Xác nhận lần ${activeStep}`}</span>
            </button>
          </div>

          {validateNotice && (
            <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5 -mt-3 leading-relaxed">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              {validateNotice}
            </p>
          )}

          {/* KẾT QUẢ CHẤM ĐIỂM CỦA GEMINI */}
          {currentValidation && (
            <div
              className={`p-4 sm:p-5 rounded-2xl border space-y-4 ${
                currentValidation.score >= 80
                  ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-800'
                  : currentValidation.score >= 50
                  ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-800'
                  : 'bg-rose-50 dark:bg-rose-950/30 border-rose-300 dark:border-rose-800'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                  {currentValidation.isCorrect ? (
                    <CheckCircle2 size={15} className="text-emerald-600" />
                  ) : (
                    <AlertTriangle size={15} className="text-rose-500" />
                  )}
                  {currentValidation.isCorrect ? 'Câu dùng đúng!' : 'Cần chỉnh lại một chút'}
                  {!currentValidation.fromAI && (
                    <span className="text-[10px] font-semibold text-slate-500">(chấm offline)</span>
                  )}
                </span>
                <span
                  className={`text-2xl font-black tabular-nums ${
                    currentValidation.score >= 80
                      ? 'text-emerald-700 dark:text-emerald-300'
                      : currentValidation.score >= 50
                      ? 'text-amber-700 dark:text-amber-300'
                      : 'text-rose-600 dark:text-rose-300'
                  }`}
                >
                  {currentValidation.score}
                  <span className="text-xs font-bold opacity-60">/100</span>
                </span>
              </div>

              {currentValidation.feedback && (
                <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed">{currentValidation.feedback}</p>
              )}

              {currentValidation.grammarCorrection &&
                currentValidation.grammarCorrection.trim() !== currentSentence.trim() && (
                  <div className="p-3 sm:p-3.5 rounded-xl bg-white/70 dark:bg-slate-900/50 space-y-1">
                    <span className="block text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Câu đã sửa ngữ pháp</span>
                    <p className="text-sm sm:text-[15px] font-medium text-slate-800 dark:text-slate-100 leading-relaxed">{currentValidation.grammarCorrection}</p>
                  </div>
                )}

              {currentValidation.betterSuggestion && (
                <div className="p-3 sm:p-3.5 rounded-xl bg-white/70 dark:bg-slate-900/50 space-y-1">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1">
                    <Wand2 size={12} className="text-indigo-500" />
                    Cách nói tự nhiên hơn
                  </span>
                  <div className="flex items-start gap-2">
                    <p className="text-sm sm:text-[15px] font-medium text-indigo-800 dark:text-indigo-300 flex-1 leading-relaxed">“{currentValidation.betterSuggestion}”</p>
                    <AudioPlayerButton fallbackText={currentValidation.betterSuggestion} size="sm" />
                  </div>
                </div>
              )}

              {completedCount < 5 && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      const nextId = STEPS.find((id) => !completedStatus[id]);
                      if (nextId) handleSelectStep(nextId);
                    }}
                    disabled={isBusy}
                    className="h-9 px-4 text-xs sm:text-sm font-bold text-emerald-700 dark:text-emerald-300 bg-white/70 dark:bg-slate-800 border border-emerald-300 dark:border-emerald-800 rounded-lg flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    Ngữ cảnh tiếp theo
                    <ChevronRight size={14} />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ĐÁNH GIÁ FSRS LINH HOẠT: KHÔNG BẮT BUỘC PHẢI NHẬP ĐỦ 5 OUTPUT */}
          <div
            className={`p-4 sm:p-5 rounded-2xl border transition-all text-center space-y-4 ${
              isAllCompleted
                ? 'bg-gradient-to-r from-amber-500/15 via-orange-500/20 to-emerald-500/15 dark:from-amber-950/50 dark:via-orange-950/50 dark:to-emerald-950/50 border-2 border-emerald-500 shadow-md'
                : 'bg-slate-50 dark:bg-slate-800/70 border-slate-200 dark:border-slate-700/80'
            }`}
          >
            {isAllCompleted ? (
              <div className="space-y-1">
                <div className="w-10 h-10 mx-auto rounded-2xl bg-emerald-600 text-white flex items-center justify-center shadow-md shadow-emerald-500/20">
                  <Flame size={22} className="fill-amber-300 animate-bounce" />
                </div>
                <h4 className="text-sm sm:text-base font-black text-slate-900 dark:text-slate-100">
                  🎉 Xuất sắc! Bạn đã luyện đủ 5 ngữ cảnh (+50 EXP thưởng)!
                </h4>
                <p className="text-[11px] sm:text-xs text-slate-600 dark:text-slate-300">
                  Chọn mức độ nhớ bên dưới để hoàn tất lượt ôn FSRS:
                </p>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2 flex-wrap text-left pb-1">
                <div className="min-w-0">
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-200 block">
                    Đánh giá mức độ nhớ
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    Không cần đủ 5 câu — bạn có thể đánh giá bất cứ lúc nào.
                  </span>
                </div>
                <span className="text-[11px] font-bold text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/60 px-2.5 py-1 rounded-full border border-amber-300 dark:border-amber-800 shrink-0">
                  Đã làm {completedCount}/5
                </span>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-2.5">
              <button
                type="button"
                id="btn-rate-modal-1"
                onClick={() => handleRate(1)}
                className="min-h-[3.5rem] p-2.5 sm:p-3 gap-0.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900 hover:bg-rose-100 font-bold text-xs flex flex-col items-center justify-center cursor-pointer active:scale-95 transition-all shadow-2xs text-center"
                title="Làm lại - Chưa nhớ được"
              >
                <span className="text-xs sm:text-sm font-bold leading-tight">Làm lại</span>
                <span className="text-[11px] opacity-75 font-semibold tabular-nums">{fsrsPreviews[1].label}</span>
              </button>
              <button
                type="button"
                id="btn-rate-modal-2"
                onClick={() => handleRate(2)}
                className="min-h-[3.5rem] p-2.5 sm:p-3 gap-0.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-900 hover:bg-amber-100 font-bold text-xs flex flex-col items-center justify-center cursor-pointer active:scale-95 transition-all shadow-2xs text-center"
                title="Cần gọt giũa - Nhớ hơi chật vật"
              >
                <span className="text-xs sm:text-sm font-bold leading-tight">Cần gọt giũa</span>
                <span className="text-[11px] opacity-75 font-semibold tabular-nums">{fsrsPreviews[2].label}</span>
              </button>
              <button
                type="button"
                id="btn-rate-modal-3"
                onClick={() => handleRate(3)}
                className="min-h-[3.5rem] p-2.5 sm:p-3 gap-0.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800 hover:bg-emerald-100 font-bold text-xs flex flex-col items-center justify-center cursor-pointer active:scale-95 transition-all shadow-2xs text-center"
                title="Trôi chảy - Phản xạ tự nhiên"
              >
                <span className="text-xs sm:text-sm font-bold leading-tight">Trôi chảy</span>
                <span className="text-[11px] opacity-75 font-semibold tabular-nums">{fsrsPreviews[3].label}</span>
              </button>
              <button
                type="button"
                id="btn-rate-modal-4"
                onClick={() => handleRate(4)}
                className="min-h-[3.5rem] p-2.5 sm:p-3 gap-0.5 rounded-xl bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-300 border border-blue-200 dark:border-blue-900 hover:bg-blue-100 font-bold text-xs flex flex-col items-center justify-center cursor-pointer active:scale-95 transition-all shadow-2xs text-center"
                title="Thành thạo - Nắm rất vững"
              >
                <span className="text-xs sm:text-sm font-bold leading-tight">Thành thạo</span>
                <span className="text-[11px] opacity-75 font-semibold tabular-nums">{fsrsPreviews[4].label}</span>
              </button>
            </div>
          </div>
        </div>

        {/* MODAL FOOTER NAVIGATION */}
        <div className="px-4 py-3 sm:px-7 border-t border-slate-100 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-850 flex items-center justify-between gap-2 shrink-0">
          <button
            type="button"
            onClick={() => handleSelectStep(Math.max(1, activeStep - 1))}
            disabled={activeStep === 1 || isBusy}
            className="h-9 px-3.5 text-xs font-bold text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed border border-slate-200 dark:border-slate-700 rounded-xl transition-all flex items-center gap-1 cursor-pointer"
          >
            <ChevronLeft size={15} />
            <span>Lần trước</span>
          </button>

          <span className="text-xs font-bold text-slate-500 dark:text-slate-400">
            Lần {activeStep} / 5
          </span>

          <button
            type="button"
            onClick={() => handleSelectStep(Math.min(5, activeStep + 1))}
            disabled={activeStep === 5 || isBusy}
            className="h-9 px-3.5 text-xs font-bold text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed border border-slate-200 dark:border-slate-700 rounded-xl transition-all flex items-center gap-1 cursor-pointer"
          >
            <span>Lần sau</span>
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
