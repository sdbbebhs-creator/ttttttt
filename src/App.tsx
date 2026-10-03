import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './utils/supabaseClient';
import {
  pullAndMerge,
  pullRemoteChanges,
  pushLocalChanges,
  countPendingChanges,
  claimLocalCopy,
  clearLocalCopy,
  flushBeforeSignOut,
  stashPendingChanges,
  hasSyncBase,
  type SyncedData,
} from './utils/syncClient';
import { onLocalChange } from './utils/localChanges';
import { newItemId, withItemId } from './utils/itemIds';
import { reloadFSRSSettings } from './utils/fsrs';
import { AuthScreen } from './components/AuthScreen';
import { Calendar, Layers, BookOpen, FileText, BarChart3, Plus, CheckCircle2, Gamepad2 } from 'lucide-react';
import { VocabItem, GrammarItem, ReviewRating } from './types';
import {
  getTodayDate,
  addDays,
  diffDays,
  createDefaultFSRSCard,
  updateCardFSRS,
} from './utils/fsrs';
import {
  getAllVocab,
  getAllGrammar,
  saveAllVocab,
  saveAllGrammar,
  getSampleData,
  ensureFSRSVocab,
  ensureFSRSGrammar,
  saveReviewLog,
} from './utils/storage';
import { Navbar } from './components/Navbar';
import { Sidebar, type NavItem } from './components/Sidebar';
import { DailyReviewTab } from './components/DailyReviewTab';
import { FlashcardTab } from './components/FlashcardTab';
import { VocabListTab } from './components/VocabListTab';
import { GrammarListTab } from './components/GrammarListTab';
import { StatsTab } from './components/StatsTab';
import { GameHubTab } from './components/games/GameHubTab';
import { AddEditModal } from './components/AddEditModal';
import { BackupModal } from './components/BackupModal';
import { ImageLightboxModal } from './components/ImageLightboxModal';
import { FireCelebrationOverlay } from './components/FireCelebrationOverlay';
import { ContextOutputModal } from './components/ContextOutputModal';
import { FSRSOptimizerModal } from './components/FSRSOptimizerModal';
import { RankModal } from './components/RankModal';
import { UserRankData, RankTierDefinition } from './types';
import {
  getUserRankData,
  checkDailyRankDecay,
  recordStudyForRank,
  recordAllCardsCompletedForRank,
  getRankTierByKey,
} from './utils/rankSystem';

type TabType = 'review' | 'flashcard' | 'vocab' | 'grammar' | 'games' | 'stats';

export default function App() {
  const [activeTab, setActiveTab] = useState<TabType>('review');
  const [selectedDate, setSelectedDate] = useState<string>(getTodayDate());
  const [vocabList, setVocabList] = useState<VocabItem[]>([]);
  const [grammarList, setGrammarList] = useState<GrammarItem[]>([]);

  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const hasSyncedInitialData = useRef(false);
  const syncDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cloudReady, setCloudReady] = useState(0);
  const vocabListRef = useRef(vocabList);
  const grammarListRef = useRef(grammarList);
  vocabListRef.current = vocabList;
  grammarListRef.current = grammarList;

  const userId = session?.user.id ?? null;
  const userIdRef = useRef<string | null>(null);
  const signingOutRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const getLists = useCallback(() => ({ vocab: vocabListRef.current, grammar: grammarListRef.current }), []);

  /** Làm trống dữ liệu đang hiển thị (sau khi bản sao trên máy bị xóa) */
  const resetLocalState = useCallback(() => {
    vocabListRef.current = [];
    grammarListRef.current = [];
    setVocabList([]);
    setGrammarList([]);
    reloadFSRSSettings();
    const rd = getUserRankData();
    setRankData(rd);
    setStreakCount(rd.streakCount ?? 0);
  }, []);

  // Track Supabase auth session (Supabase chỉ dùng để đăng nhập; dữ liệu nằm trong Netlify Database)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!newSession) {
        hasSyncedInitialData.current = false;
        // Phiên hết hạn / đăng xuất ở tab khác: giữ riêng thay đổi chưa gửi rồi xóa bản sao trên máy
        const prevUser = userIdRef.current;
        if (prevUser && !signingOutRef.current) {
          stashPendingChanges(prevUser, getLists);
          clearLocalCopy();
          resetLocalState();
        }
        userIdRef.current = null;
      }
      setSession(newSession);
    });

    return () => listener.subscription.unsubscribe();
  }, [getLists, resetLocalState]);

  const applySynced = useCallback((synced: SyncedData) => {
    vocabListRef.current = synced.vocab;
    grammarListRef.current = synced.grammar;
    setVocabList(synced.vocab);
    setGrammarList(synced.grammar);
    saveAllVocab(synced.vocab);
    saveAllGrammar(synced.grammar);
    if (synced.settingsChanged) {
      reloadFSRSSettings();
      const rd = getUserRankData();
      setRankData(rd);
      setStreakCount(rd.streakCount ?? 0);
    }
  }, []);

  /**
   * Đồng bộ với tài khoản: lần đầu tải toàn bộ (kèm chuyển dữ liệu cũ), sau đó gửi
   * thay đổi đang chờ và chỉ tải phần thiết bị khác vừa đổi.
   */
  const syncNow = useCallback(async () => {
    const uid = userIdRef.current;
    if (!uid || syncInFlightRef.current || signingOutRef.current) return;
    syncInFlightRef.current = true;
    try {
      if (!hasSyncedInitialData.current) {
        const synced = await pullAndMerge(uid, getLists);
        if (userIdRef.current !== uid) return;
        applySynced(synced);
        hasSyncedInitialData.current = true;
        setCloudReady((n) => n + 1);
        if (synced.settingsChanged) runDailyRankCheckRef.current();
        return;
      }
      await pushLocalChanges(uid, getLists).catch((err) => console.warn('Chưa gửi được thay đổi:', err));
      const synced = await pullRemoteChanges(uid, getLists);
      if (synced && userIdRef.current === uid) {
        applySynced(synced);
        if (synced.settingsChanged) runDailyRankCheckRef.current();
      }
    } catch (err) {
      console.warn('Chưa kết nối được tài khoản, tiếp tục dùng dữ liệu trên máy:', err);
    } finally {
      syncInFlightRef.current = false;
    }
  }, [getLists, applySynced]);

  // On login: make sure the local copy belongs to this account, show it, then pull the account
  useEffect(() => {
    if (!userId) return;
    userIdRef.current = userId;
    hasSyncedInitialData.current = false;
    let cancelled = false;

    (async () => {
      if (await claimLocalCopy(userId)) {
        // Bản sao trên máy thuộc tài khoản khác → đã xóa, không hiển thị
        resetLocalState();
      } else {
        try {
          const [loadedVocab, loadedGrammar] = await Promise.all([getAllVocab(), getAllGrammar()]);
          if (cancelled || hasSyncedInitialData.current) return;
          vocabListRef.current = loadedVocab;
          grammarListRef.current = loadedGrammar;
          setVocabList(loadedVocab);
          setGrammarList(loadedGrammar);
        } catch (err) {
          console.error('Failed to load local copy:', err);
        }
      }
      if (cancelled) return;
      runDailyRankCheckRef.current();
      await syncNow();
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, resetLocalState, syncNow]);

  // Debounced push of local changes to the account while logged in
  useEffect(() => {
    if (!userId || !hasSyncedInitialData.current) return;

    countPendingChanges(userId, vocabListRef.current, grammarListRef.current);
    if (syncDebounceTimer.current) clearTimeout(syncDebounceTimer.current);
    const schedule = () => {
      countPendingChanges(userId, vocabListRef.current, grammarListRef.current);
      if (syncDebounceTimer.current) clearTimeout(syncDebounceTimer.current);
      syncDebounceTimer.current = setTimeout(() => {
        pushLocalChanges(userId, getLists).catch((err) =>
          console.warn('Chưa gửi được thay đổi, sẽ thử lại khi có mạng:', err)
        );
      }, 1500);
    };
    schedule();
    const unsubscribe = onLocalChange(schedule);

    return () => {
      unsubscribe();
      if (syncDebounceTimer.current) clearTimeout(syncDebounceTimer.current);
    };
  }, [userId, vocabList, grammarList, cloudReady, getLists]);

  // Changes from other devices: check every 15s, when the tab is visible again and when back online
  useEffect(() => {
    if (!userId) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') syncNow();
    }, 15000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') syncNow();
    };
    window.addEventListener('online', syncNow);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', syncNow);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId, syncNow]);

  // Sign out: send everything first, warn if something is still pending, then clear the local copy
  const handleLogout = useCallback(async () => {
    const uid = userIdRef.current;
    if (!uid || signingOutRef.current) return;
    setIsLoggingOut(true);
    try {
      if (!hasSyncedInitialData.current) await syncNow();
      const pending = await flushBeforeSignOut(uid, getLists);
      const neverSynced = !hasSyncBase(uid);

      if (neverSynced && (vocabListRef.current.length > 0 || grammarListRef.current.length > 0)) {
        const ok = window.confirm(
          '⚠️ Chưa kết nối được với tài khoản nên dữ liệu trên máy này chưa được gửi lên.\n\nNếu đăng xuất bây giờ, bản sao trên máy sẽ bị xóa và những thay đổi đó sẽ mất. Bạn vẫn muốn đăng xuất?'
        );
        if (!ok) return;
      } else if (pending > 0) {
        const ok = window.confirm(
          `⚠️ Còn ${pending} thay đổi chưa gửi được lên tài khoản (có thể do mất mạng).\n\nNếu đăng xuất bây giờ, các thay đổi này được giữ riêng trên máy và tự gửi lên khi bạn đăng nhập lại bằng đúng tài khoản này. Bạn vẫn muốn đăng xuất?`
        );
        if (!ok) return;
        if (!stashPendingChanges(uid, getLists)) {
          const force = window.confirm(
            '⚠️ Bộ nhớ trình duyệt đã đầy nên không giữ lại được các thay đổi chưa gửi. Đăng xuất bây giờ sẽ làm mất chúng. Vẫn đăng xuất?'
          );
          if (!force) return;
        }
      }

      signingOutRef.current = true;
      await clearLocalCopy();
      resetLocalState();
      hasSyncedInitialData.current = false;
      userIdRef.current = null;
      await supabase.auth.signOut();
    } finally {
      signingOutRef.current = false;
      setIsLoggingOut(false);
    }
  }, [getLists, syncNow, resetLocalState]);

  const handleSwitchTab = useCallback((tab: TabType) => {
    setActiveTab(tab);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  // Ensure whenever activeTab changes, the viewport scrolls immediately to top
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [activeTab]);

  // Harmonious Dark Theme State (defaults to true as requested)
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('theme_mode');
      if (saved) return saved === 'dark';
    } catch {}
    return true; // Default to dark mode
  });

  useEffect(() => {
    try {
      localStorage.setItem('theme_mode', isDarkMode ? 'dark' : 'light');
    } catch {}
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  // Modals
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<{
    type: 'vocab' | 'grammar';
    data: VocabItem | GrammarItem;
  } | null>(null);
  const [isBackupModalOpen, setIsBackupModalOpen] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<{ url: string; caption?: string } | null>(null);
  
  // Fire Celebration & Animated Rank Bar Fill Config
  const [fireCelebrationConfig, setFireCelebrationConfig] = useState<{
    isOpen: boolean;
    mode: 'rank-defense' | 'streak' | 'rank-up';
    rankData?: UserRankData;
    targetCards?: number;
    reviewedCards?: number;
    startPercent?: number;
    newTier?: RankTierDefinition;
  }>({
    isOpen: false,
    mode: 'rank-defense',
  });

  const [contextModalItem, setContextModalItem] = useState<VocabItem | GrammarItem | null>(null);
  const [showFSRSOptimizer, setShowFSRSOptimizer] = useState<boolean>(false);

  // Streak & Rank System (Default streak is 0 as requested)
  const [rankData, setRankData] = useState<UserRankData>(getUserRankData);
  const [streakCount, setStreakCount] = useState<number>(() => {
    const init = getUserRankData();
    return init.streakCount ?? 0;
  });
  const [isStreakJumping, setIsStreakJumping] = useState<boolean>(false);
  const [isRankModalOpen, setIsRankModalOpen] = useState<boolean>(false);

  // Toast
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  // Update streak and EXP for Rank when an item is reviewed or output is submitted
  const recordStudyActivity = useCallback((rating?: ReviewRating, isContextOutput = false, progressMessage?: string) => {
    const today = getTodayDate();
    const result = recordStudyForRank({ rating, isContextOutput, todayDate: today });

    setRankData(result.rankData);
    setStreakCount(result.rankData.streakCount);

    // Kích hoạt hiệu ứng lửa nhảy ăn mừng ở Navbar
    setIsStreakJumping(true);
    setTimeout(() => setIsStreakJumping(false), 1400);

    const tier = getRankTierByKey(result.rankData.tierKey);

    if (result.rankUp && result.newTier) {
      showToast(`🎉 THĂNG HẠNG: Chúc mừng bạn đã lên Rank ${result.newTier.nameVi} (${result.newTier.titleVi})! +${result.expGained} EXP`);
      setFireCelebrationConfig({
        isOpen: true,
        mode: 'rank-up',
        rankData: result.rankData,
        newTier: result.newTier,
        startPercent: result.prevProgressPercent,
        targetCards: result.targetCards,
        reviewedCards: result.rankData.todayReviewedCount,
      });
    } else {
      showToast(
        progressMessage ??
          (result.rankData.todayProtected
            ? `🔥 +${result.expGained} EXP · Chuỗi ${result.rankData.streakCount} ngày · Rank ${tier.nameVi} đã được giữ hôm nay`
            : `🔥 +${result.expGained} EXP · Chuỗi ${result.rankData.streakCount} ngày · Cần hoàn thành tất cả lịch thẻ để bảo vệ Rank ${tier.nameVi}!`)
      );
    }
  }, []);

  // After a review: the day only counts (streak +1, rank kept) once nothing is due today anymore.
  // Always uses the real current date, never the date picked in the calendar, so reviewing
  // another day's cards can't grant a streak for that day.
  const recordReviewProgressForRank = useCallback(
    (
      vocab: VocabItem[],
      grammar: GrammarItem[],
      cardsReviewedCount: number,
      rating: ReviewRating | undefined,
      progressMessage: (remainingVocab: number, remainingGrammar: number) => string
    ) => {
      const today = getTodayDate();
      const remainingVocab = vocab.filter((item) => item.reviewDate <= today).length;
      const remainingGrammar = grammar.filter((item) => item.reviewDate <= today).length;

      if (remainingVocab + remainingGrammar > 0) {
        // Còn thẻ chưa hoàn thành: chưa tăng streak và chưa bảo vệ rank
        recordStudyActivity(rating, false, progressMessage(remainingVocab, remainingGrammar));
        return;
      }

      if (getUserRankData().lastCompletedAllScheduleDate === today) {
        // Đã nhận thưởng hoàn thành hôm nay: ôn thêm chỉ được EXP thường, không nhận lại thưởng cả ngày
        recordStudyActivity(rating, false, '✅ Đã hoàn thành lịch hôm nay · Ôn thêm được cộng EXP thường.');
        return;
      }

      // Hoàn thành TẤT CẢ lịch thẻ hôm nay: mới được + streak và bảo vệ rank!
      const result = recordAllCardsCompletedForRank({ todayDate: today, cardsReviewedCount });

      setRankData(result.rankData);
      setStreakCount(result.rankData.streakCount);

      setIsStreakJumping(true);
      setTimeout(() => setIsStreakJumping(false), 1400);

      const tier = getRankTierByKey(result.rankData.tierKey);

      // Hiệu ứng bốc lửa bảo vệ rank chỉ hiện lên 1 lần khi làm xong!
      if (result.shouldShowCelebration) {
        setFireCelebrationConfig({
          isOpen: true,
          mode: result.rankUp ? 'rank-up' : 'rank-defense',
          rankData: result.rankData,
          newTier: result.newTier,
          targetCards: cardsReviewedCount,
          reviewedCards: cardsReviewedCount,
          startPercent: 0,
        });
      }

      if (result.rankUp && result.newTier) {
        showToast(`🎉 THĂNG HẠNG: Chúc mừng bạn đã lên Rank ${result.newTier.nameVi} (${result.newTier.titleVi})! Đã hoàn thành tất cả lịch thẻ hôm nay! +${result.expGained} EXP`);
      } else if (result.justProtectedRank) {
        showToast(`🔥 HOÀN THÀNH TẤT CẢ LỊCH THẺ HÔM NAY! ĐÃ BẢO VỆ RANK ${tier.nameVi.toUpperCase()} & +1 CHUỖI LỬA! +${result.expGained} EXP`);
      } else {
        showToast(`🔥 Đã hoàn thành tất cả lịch thẻ hôm nay! +${result.expGained} EXP`);
      }
    },
    [recordStudyActivity]
  );

  // Callback to update completed context outputs for both Vocab and Grammar
  const handleCompleteContexts = useCallback((itemId: string, outputs: Record<number, string>, kind: 'vocab' | 'grammar') => {
    const count = Object.values(outputs).filter((s) => s && s.trim().length > 0).length;

    if (kind === 'vocab') {
      setVocabList((prev) => {
        const updated = prev.map((v) => {
          if (v.id === itemId) {
            return {
              ...v,
              completedContextsCount: count,
              contextOutputs: outputs,
              lastOutputDate: selectedDate,
            };
          }
          return v;
        });
        saveAllVocab(updated);
        return updated;
      });
    } else {
      setGrammarList((prev) => {
        const updated = prev.map((g) => {
          if (g.id === itemId) {
            return {
              ...g,
              completedContextsCount: count,
              contextOutputs: outputs,
              lastOutputDate: selectedDate,
            };
          }
          return g;
        });
        saveAllGrammar(updated);
        return updated;
      });
    }

    setContextModalItem((prev) => {
      if (prev && prev.id === itemId) {
        return {
          ...prev,
          completedContextsCount: count,
          contextOutputs: outputs,
          lastOutputDate: selectedDate,
        } as VocabItem | GrammarItem;
      }
      return prev;
    });

    if (count >= 5) {
      recordStudyActivity(undefined, true);
    }
  }, [selectedDate, recordStudyActivity]);

  const lastRankCheckDateRef = useRef<string | null>(null);
  const runDailyRankCheckRef = useRef<() => void>(() => {});

  // Daily Rank & Streak Maintenance check. Past days only count as missed if they had due cards.
  const runDailyRankCheck = useCallback(() => {
    const today = getTodayDate();
    lastRankCheckDateRef.current = today;
    const dueDates = [...vocabListRef.current, ...grammarListRef.current].map((item) => item.reviewDate);
    const decayResult = checkDailyRankDecay(today, dueDates);
    setRankData(decayResult.rankData);
    setStreakCount(decayResult.rankData.streakCount);

    if (decayResult.decayed) {
      showToast(`⚠️ Bỏ lỡ ngày học: Chuỗi lửa reset về 0 và rank tụt xuống ${getRankTierByKey(decayResult.rankData.tierKey).nameVi}!`);
    } else if (decayResult.shieldUsed) {
      showToast(`🛡️ Đã dùng ${decayResult.shieldsUsed} Khiên bảo vệ để giữ vững Rank & Chuỗi lửa cho bạn!`);
    }
  }, []);

  // The local copy is loaded (and the daily rank check run) by the login effect above
  runDailyRankCheckRef.current = runDailyRankCheck;

  // Re-run the daily check when the app is reopened on a new day (e.g. left open overnight)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && lastRankCheckDateRef.current && lastRankCheckDateRef.current !== getTodayDate()) {
        runDailyRankCheck();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [runDailyRankCheck]);

  // Rate a Vocab item with FSRS
  const handleRateVocab = useCallback(
    (id: string, rating: ReviewRating) => {
      const updatedVocabList = vocabList.map((item) => {
        if (item.id === id) {
          const { updatedCard } = updateCardFSRS(item, rating);
          saveReviewLog({
            itemId: id,
            itemType: 'vocab',
            rating,
            timestamp: new Date().toISOString(),
            prevScheduledDays: item.scheduled_days || item.interval || 0,
            nextScheduledDays: updatedCard.scheduled_days || updatedCard.interval || 1,
            stability: updatedCard.stability || 0,
            difficulty: updatedCard.difficulty || 0,
            state: updatedCard.state || 2,
          });
          return {
            ...updatedCard,
            lastOutputDate: item.lastOutputDate || selectedDate,
          };
        }
        return item;
      });

      setVocabList(updatedVocabList);
      saveAllVocab(updatedVocabList);

      recordReviewProgressForRank(updatedVocabList, grammarList, 1, rating, (v, g) =>
        `Đã ôn 1 từ vựng! Còn ${v + g} thẻ đến hạn hôm nay (V:${v}, G:${g}) cần ôn để bảo vệ Rank & tăng chuỗi!`
      );
    },
    [vocabList, grammarList, selectedDate, recordReviewProgressForRank]
  );

  // Rate a Grammar item with FSRS
  const handleRateGrammar = useCallback(
    (id: string, rating: ReviewRating) => {
      const updatedGrammarList = grammarList.map((item) => {
        if (item.id === id) {
          const { updatedCard } = updateCardFSRS(item, rating);
          saveReviewLog({
            itemId: id,
            itemType: 'grammar',
            rating,
            timestamp: new Date().toISOString(),
            prevScheduledDays: item.scheduled_days || item.interval || 0,
            nextScheduledDays: updatedCard.scheduled_days || updatedCard.interval || 1,
            stability: updatedCard.stability || 0,
            difficulty: updatedCard.difficulty || 0,
            state: updatedCard.state || 2,
          });
          return {
            ...updatedCard,
            lastOutputDate: item.lastOutputDate || selectedDate,
          };
        }
        return item;
      });

      setGrammarList(updatedGrammarList);
      saveAllGrammar(updatedGrammarList);

      recordReviewProgressForRank(vocabList, updatedGrammarList, 1, rating, (v, g) =>
        `Đã ôn 1 ngữ pháp! Còn ${v + g} thẻ đến hạn hôm nay (V:${v}, G:${g}) cần ôn để bảo vệ Rank & tăng chuỗi!`
      );
    },
    [grammarList, vocabList, selectedDate, recordReviewProgressForRank]
  );

  // Batch review all due items
  const handleMarkAllReviewed = useCallback(
    (type: 'vocab' | 'grammar') => {
      const sourceList: Array<VocabItem | GrammarItem> = type === 'vocab' ? vocabList : grammarList;
      const dueCount = sourceList.filter((item) => item.reviewDate <= selectedDate).length;
      if (dueCount === 0) {
        showToast(type === 'vocab' ? 'Không có từ vựng nào đến hạn để đánh dấu.' : 'Không có điểm ngữ pháp nào đến hạn để đánh dấu.');
        return;
      }

      const markDue = <T extends VocabItem | GrammarItem>(list: T[]): T[] =>
        list.map((item) => {
          if (item.reviewDate <= selectedDate) {
            const { updatedCard } = updateCardFSRS(item, 3);
            return {
              ...updatedCard,
              lastOutputDate: item.lastOutputDate || selectedDate,
            } as T;
          }
          return item;
        });

      if (type === 'vocab') {
        const updatedVocabList = markDue(vocabList);
        setVocabList(updatedVocabList);
        saveAllVocab(updatedVocabList);
        recordReviewProgressForRank(updatedVocabList, grammarList, dueCount, 3, (v, g) =>
          `Đã ôn tất cả từ vựng! Còn ${v + g} thẻ đến hạn hôm nay (V:${v}, G:${g}) cần hoàn thành để bảo vệ Rank & tăng chuỗi!`
        );
      } else {
        const updatedGrammarList = markDue(grammarList);
        setGrammarList(updatedGrammarList);
        saveAllGrammar(updatedGrammarList);
        recordReviewProgressForRank(vocabList, updatedGrammarList, dueCount, 3, (v, g) =>
          `Đã ôn tất cả ngữ pháp! Còn ${v + g} thẻ đến hạn hôm nay (V:${v}, G:${g}) cần hoàn thành để bảo vệ Rank & tăng chuỗi!`
        );
      }
    },
    [vocabList, grammarList, selectedDate, recordReviewProgressForRank]
  );

  // Save new or edited Vocab
  const handleSaveVocab = (itemData: Partial<VocabItem>) => {
    const existing = itemData.id ? vocabList.find((v) => v.id === itemData.id) : undefined;
    if (existing) {
      // Edit: cập nhật đúng thẻ có id này (được gửi lên tài khoản qua hàng chờ đồng bộ)
      const edited = { ...existing, ...itemData } as VocabItem;
      setVocabList((prev) => {
        const updated = prev.map((v) => (v.id === edited.id ? edited : v));
        saveAllVocab(updated);
        return updated;
      });
      showToast('Đã lưu thay đổi từ vựng!');
    } else {
      // Add
      const newItem: VocabItem = {
        ...createDefaultFSRSCard(itemData.reviewDate || getTodayDate()),
        id: newItemId(),
        word: itemData.word || '',
        phonetic: itemData.phonetic,
        meaning: itemData.meaning || '',
        type: itemData.type || 'n',
        topic: itemData.topic || 'Chung',
        example: itemData.example,
        exampleVi: itemData.exampleVi,
        imageUrl: itemData.imageUrl,
        audioUrl: itemData.audioUrl,
        createdAt: new Date().toISOString(),
      };
      setVocabList((prev) => {
        const updated = [newItem, ...prev];
        saveAllVocab(updated);
        return updated;
      });
      // Thẻ mới = UUID riêng, không bao giờ ghi đè thẻ cũ
      showToast('Đã thêm từ vựng mới thành công!');
    }
    setEditingItem(null);
  };

  // Save new or edited Grammar
  const handleSaveGrammar = (itemData: Partial<GrammarItem>) => {
    const existing = itemData.id ? grammarList.find((g) => g.id === itemData.id) : undefined;
    if (existing) {
      const edited = { ...existing, ...itemData } as GrammarItem;
      setGrammarList((prev) => {
        const updated = prev.map((g) => (g.id === edited.id ? edited : g));
        saveAllGrammar(updated);
        return updated;
      });
      showToast('Đã lưu thay đổi ngữ pháp!');
    } else {
      const newItem: GrammarItem = {
        ...createDefaultFSRSCard(itemData.reviewDate || getTodayDate()),
        id: newItemId(),
        title: itemData.title || '',
        type: itemData.type || 'Cấu trúc',
        formula: itemData.formula || '',
        explanation: itemData.explanation || '',
        example: itemData.example,
        exampleVi: itemData.exampleVi,
        imageUrl: itemData.imageUrl,
        audioUrl: itemData.audioUrl,
        createdAt: new Date().toISOString(),
      };
      setGrammarList((prev) => {
        const updated = [newItem, ...prev];
        saveAllGrammar(updated);
        return updated;
      });
      showToast('Đã thêm điểm ngữ pháp mới!');
    }
    setEditingItem(null);
  };

  // Delete handlers
  const handleDeleteVocab = (id: string) => {
    let confirmed = true;
    try {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        confirmed = window.confirm('Bạn có chắc chắn muốn xóa từ vựng này không?');
      }
    } catch {
      confirmed = true;
    }
    if (confirmed) {
      setVocabList((prev) => {
        const updated = prev.filter((v) => v.id !== id);
        saveAllVocab(updated);
        return updated;
      });
      showToast('Đã xóa từ vựng.');
    }
  };

  const handleDeleteGrammar = (id: string) => {
    let confirmed = true;
    try {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        confirmed = window.confirm('Bạn có chắc chắn muốn xóa điểm ngữ pháp này không?');
      }
    } catch {
      confirmed = true;
    }
    if (confirmed) {
      setGrammarList((prev) => {
        const updated = prev.filter((g) => g.id !== id);
        saveAllGrammar(updated);
        return updated;
      });
      showToast('Đã xóa điểm ngữ pháp.');
    }
  };

  // Import JSON data (added/changed/removed cards reach the account through the sync queue)
  const handleImportData = (importedVocab: VocabItem[], importedGrammar: GrammarItem[], mode: 'merge' | 'replace') => {
    const newVocab = importedVocab.map(withItemId);
    const newGrammar = importedGrammar.map(withItemId);
    if (mode === 'replace') {
      setVocabList(newVocab);
      setGrammarList(newGrammar);
      saveAllVocab(newVocab);
      saveAllGrammar(newGrammar);
    } else {
      // Merge
      const existingVocabIds = new Set(vocabList.map((v) => v.id));
      const mergedVocab = [...vocabList, ...newVocab.filter((v) => !existingVocabIds.has(v.id))];

      const existingGrammarIds = new Set(grammarList.map((g) => g.id));
      const mergedGrammar = [...grammarList, ...newGrammar.filter((g) => !existingGrammarIds.has(g.id))];

      setVocabList(mergedVocab);
      setGrammarList(mergedGrammar);
      saveAllVocab(mergedVocab);
      saveAllGrammar(mergedGrammar);
    }
    showToast('Đã khôi phục dữ liệu thành công!');
  };

  // Load sample pack (fresh UUIDs so each load creates its own rows)
  const handleLoadSampleData = () => {
    const sample = getSampleData();
    const vocab = sample.vocab.map((v) => ({ ...v, id: newItemId() }));
    const grammar = sample.grammar.map((g) => ({ ...g, id: newItemId() }));
    setVocabList(vocab);
    setGrammarList(grammar);
    saveAllVocab(vocab);
    saveAllGrammar(grammar);
    showToast('Đã nạp bộ dữ liệu mẫu!');
  };

  // Clear all
  const handleClearAllData = () => {
    setVocabList([]);
    setGrammarList([]);
    saveAllVocab([]);
    saveAllGrammar([]);
    showToast('Đã xóa toàn bộ dữ liệu.');
  };

  // Calculate due count badge for today
  const todayDueCount =
    vocabList.filter((v) => v.reviewDate <= getTodayDate()).length +
    grammarList.filter((g) => g.reviewDate <= getTodayDate()).length;

  const openAddModal = useCallback(() => {
    setEditingItem(null);
    setIsAddModalOpen(true);
  }, []);

  const navItems: NavItem<TabType>[] = [
    { id: 'review', label: 'Ôn tập hôm nay', shortLabel: 'Ôn tập', description: 'Lịch ôn theo FSRS và hàng đợi ưu tiên', icon: Calendar, badge: todayDueCount },
    { id: 'flashcard', label: 'Thẻ lật', shortLabel: 'Thẻ lật', description: 'Lật thẻ và tự đánh giá mức độ nhớ', icon: Layers },
    { id: 'vocab', label: 'Từ vựng', shortLabel: 'Từ vựng', description: `${vocabList.length} từ trong kho`, icon: BookOpen, badge: vocabList.length },
    { id: 'grammar', label: 'Ngữ pháp', shortLabel: 'Ngữ pháp', description: `${grammarList.length} điểm ngữ pháp`, icon: FileText, badge: grammarList.length },
    { id: 'games', label: 'Đấu trường 3D', shortLabel: 'Game', description: 'Ôn tập qua mini-game 3D', icon: Gamepad2, badge: '3D', badgeTone: 'accent' },
    { id: 'stats', label: 'Thống kê', shortLabel: 'Thống kê', description: 'Tiến độ, độ ghi nhớ và trí nhớ dài hạn', icon: BarChart3 },
  ];
  const activeNavItem = navItems.find((n) => n.id === activeTab) ?? navItems[0];

  // Keyboard shortcut: "N" opens the add modal, 1–6 switch sections.
  // Flashcards and games own the keyboard, so shortcuts are off there.
  useEffect(() => {
    if (activeTab === 'flashcard' || activeTab === 'games') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (document.querySelector('[role="dialog"], .fixed.inset-0')) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        openAddModal();
        return;
      }
      const idx = Number(e.key) - 1;
      const order: TabType[] = ['review', 'flashcard', 'vocab', 'grammar', 'games', 'stats'];
      if (idx >= 0 && idx < order.length) setActiveTab(order[idx]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openAddModal, activeTab]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-slate-50 dark:bg-slate-950">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-600/25 animate-pulse" />
        <div className="w-24 h-1 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
          <div className="h-full w-1/3 rounded-full bg-emerald-500 animate-[rank-bar-shimmer_1.2s_linear_infinite]" />
        </div>
      </div>
    );
  }

  if (!session) {
    return <AuthScreen />;
  }

  return (
    <div
      id="app-root-container"
      className="app-backdrop min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 flex font-sans"
    >
      {/* Desktop sidebar */}
      <Sidebar
        items={navItems}
        activeId={activeTab}
        onSelect={setActiveTab}
        onOpenAddModal={openAddModal}
        onOpenBackupModal={() => setIsBackupModalOpen(true)}
        isDarkMode={isDarkMode}
        onToggleDarkMode={() => setIsDarkMode((prev) => !prev)}
        onLogoClick={() => setActiveTab('review')}
        userEmail={session.user.email}
        onLogout={handleLogout}
          isLoggingOut={isLoggingOut}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top bar */}
        <Navbar
          onOpenAddModal={openAddModal}
          onOpenBackupModal={() => setIsBackupModalOpen(true)}
          onOpenOptimizer={() => setShowFSRSOptimizer(true)}
          onLoadSampleData={handleLoadSampleData}
          hasItems={vocabList.length > 0 || grammarList.length > 0}
          streakCount={streakCount}
          isStreakJumping={isStreakJumping}
          onStreakClick={() => {
            setIsRankModalOpen(true);
          }}
          isDarkMode={isDarkMode}
          onToggleDarkMode={() => setIsDarkMode((prev) => !prev)}
          rankData={rankData}
          onOpenRankModal={() => setIsRankModalOpen(true)}
          onLogoClick={() => setActiveTab('review')}
          userEmail={session.user.email}
          onLogout={handleLogout}
          isLoggingOut={isLoggingOut}
          pageTitle={activeNavItem.label}
          pageDescription={activeNavItem.description}
        />

        {/* Main Container */}
        <main className="max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-10 py-5 sm:py-8 pb-28 md:pb-12 flex-1 flex flex-col">
          {/* Tab Content Display */}
          <div key={activeTab} className="flex-1 animate-fade-in">
            {activeTab === 'review' && (
              <DailyReviewTab
                vocabList={vocabList}
                grammarList={grammarList}
                selectedDate={selectedDate}
                onSelectDate={setSelectedDate}
                onRateVocab={handleRateVocab}
                onRateGrammar={handleRateGrammar}
                onMarkAllReviewed={handleMarkAllReviewed}
                onEditVocab={(v) => {
                  setEditingItem({ type: 'vocab', data: v });
                  setIsAddModalOpen(true);
                }}
                onEditGrammar={(g) => {
                  setEditingItem({ type: 'grammar', data: g });
                  setIsAddModalOpen(true);
                }}
                onDeleteVocab={handleDeleteVocab}
                onDeleteGrammar={handleDeleteGrammar}
                onOpenImageLightbox={(url, cap) => setLightboxImage({ url, caption: cap })}
                onSwitchToFlashcard={() => setActiveTab('flashcard')}
                onSwitchToGames={() => setActiveTab('games')}
                onOpenContextOutputModal={(v) => setContextModalItem(v)}
                rankData={rankData}
                onOpenRankModal={() => setIsRankModalOpen(true)}
              />
            )}

            {activeTab === 'flashcard' && (
              <FlashcardTab
                vocabList={vocabList}
                grammarList={grammarList}
                selectedDate={selectedDate}
                onRateVocab={handleRateVocab}
                onRateGrammar={handleRateGrammar}
                onOpenImageLightbox={(url, cap) => setLightboxImage({ url, caption: cap })}
                onOpenContextOutputModal={(v) => setContextModalItem(v)}
              />
            )}

            {activeTab === 'vocab' && (
              <VocabListTab
                vocabList={vocabList}
                onOpenAddModal={() => {
                  setEditingItem(null);
                  setIsAddModalOpen(true);
                }}
                onEditVocab={(v) => {
                  setEditingItem({ type: 'vocab', data: v });
                  setIsAddModalOpen(true);
                }}
                onDeleteVocab={handleDeleteVocab}
                onOpenImageLightbox={(url, cap) => setLightboxImage({ url, caption: cap })}
                onOpenContextOutputModal={(v) => setContextModalItem(v)}
              />
            )}

            {activeTab === 'grammar' && (
              <GrammarListTab
                grammarList={grammarList}
                onOpenAddModal={() => {
                  setEditingItem(null);
                  setIsAddModalOpen(true);
                }}
                onEditGrammar={(g) => {
                  setEditingItem({ type: 'grammar', data: g });
                  setIsAddModalOpen(true);
                }}
                onDeleteGrammar={handleDeleteGrammar}
                onOpenImageLightbox={(url, cap) => setLightboxImage({ url, caption: cap })}
                onOpenContextOutputModal={(g) => setContextModalItem(g)}
              />
            )}

            {activeTab === 'games' && (
              <GameHubTab
                vocabList={vocabList}
                grammarList={grammarList}
                onShowToast={showToast}
              />
            )}

            {activeTab === 'stats' && (
              <StatsTab
                vocabList={vocabList}
                grammarList={grammarList}
                streakCount={streakCount}
                onOpenOptimizer={() => setShowFSRSOptimizer(true)}
                rankData={rankData}
                onOpenRankModal={() => setIsRankModalOpen(true)}
              />
            )}
          </div>
        </main>
      </div>

      {/* Mobile Floating Add Button */}
      <button
        type="button"
        onClick={openAddModal}
        className="md:hidden fixed right-4 z-30 w-14 h-14 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:scale-90 text-white shadow-xl shadow-emerald-700/30 ring-1 ring-inset ring-white/15 flex items-center justify-center transition-all cursor-pointer"
        style={{ bottom: 'calc(5rem + env(safe-area-inset-bottom, 0px))' }}
        aria-label="Thêm mới"
      >
        <Plus size={24} strokeWidth={2.25} />
      </button>

      {/* Mobile Bottom Navigation Bar (Safe Area aware) */}
      <nav
        id="mobile-bottom-nav"
        aria-label="Điều hướng chính"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white/85 dark:bg-slate-950/85 backdrop-blur-xl border-t border-slate-200/80 dark:border-slate-800/80 px-2 pt-1.5 flex items-stretch safe-area-pb"
      >
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              aria-current={active ? 'page' : undefined}
              className={`flex-1 min-w-0 flex flex-col items-center justify-center gap-1 py-1 rounded-xl transition-colors cursor-pointer ${
                active
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-slate-500 dark:text-slate-400 active:text-slate-800 dark:active:text-slate-200'
              }`}
            >
              <span
                className={`relative flex items-center justify-center w-12 h-7 rounded-full transition-colors ${
                  active ? 'bg-emerald-500/12 dark:bg-emerald-400/12' : ''
                }`}
              >
                <Icon size={19} strokeWidth={active ? 2.3 : 2} />
                {item.id === 'review' && todayDueCount > 0 && (
                  <span className="absolute -top-1 right-1 min-w-[16px] h-4 px-1 bg-rose-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center ring-2 ring-white dark:ring-slate-950 tabular-nums">
                    {todayDueCount > 99 ? '99+' : todayDueCount}
                  </span>
                )}
              </span>
              <span className={`text-[10px] leading-none tracking-tight truncate ${active ? 'font-semibold' : 'font-medium'}`}>
                {item.shortLabel}
              </span>
            </button>
          );
        })}
      </nav>

      {/* Modals */}
      <AddEditModal
        isOpen={isAddModalOpen}
        onClose={() => {
          setIsAddModalOpen(false);
          setEditingItem(null);
        }}
        onSaveVocab={handleSaveVocab}
        onSaveGrammar={handleSaveGrammar}
        editingItem={editingItem}
        vocabCount={vocabList.length}
        grammarCount={grammarList.length}
        existingTopics={Array.from(new Set([...vocabList.map(v => v.topic).filter(Boolean), ...grammarList.map(g => g.type).filter(Boolean)])) as string[]}
      />

      <BackupModal
        isOpen={isBackupModalOpen}
        onClose={() => setIsBackupModalOpen(false)}
        vocabList={vocabList}
        grammarList={grammarList}
        onImportData={handleImportData}
        onLoadSampleData={handleLoadSampleData}
        onClearAllData={handleClearAllData}
      />

      <ImageLightboxModal
        imageUrl={lightboxImage?.url || null}
        caption={lightboxImage?.caption}
        onClose={() => setLightboxImage(null)}
      />

      {/* Screen Fire Celebration & Animated Filling Rank Bar Overlay */}
      <FireCelebrationOverlay
        isOpen={fireCelebrationConfig.isOpen}
        onClose={() => setFireCelebrationConfig((prev) => ({ ...prev, isOpen: false }))}
        streakCount={streakCount}
        mode={fireCelebrationConfig.mode}
        rankData={fireCelebrationConfig.rankData || rankData}
        targetCards={fireCelebrationConfig.targetCards}
        reviewedCards={fireCelebrationConfig.reviewedCards}
        startPercent={fireCelebrationConfig.startPercent}
        newTier={fireCelebrationConfig.newTier}
        onOpenRankModal={() => {
          setFireCelebrationConfig((prev) => ({ ...prev, isOpen: false }));
          setIsRankModalOpen(true);
        }}
      />

      {/* 5-Context Output Practice Modal */}
      {contextModalItem && (
        <ContextOutputModal
          isOpen={Boolean(contextModalItem)}
          item={contextModalItem}
          itemKind={'formula' in contextModalItem ? 'grammar' : 'vocab'}
          onClose={() => setContextModalItem(null)}
          onCompleteContexts={handleCompleteContexts}
          onRateVocab={handleRateVocab}
          onRateGrammar={handleRateGrammar}
          todayDate={selectedDate}
        />
      )}

      {/* AI FSRS Memory Optimizer Modal */}
      <FSRSOptimizerModal
        isOpen={showFSRSOptimizer}
        onClose={() => setShowFSRSOptimizer(false)}
        vocabList={vocabList}
        grammarList={grammarList}
        onTargetRetentionChanged={(newRetention) => {
          showToast(`🎯 Đã áp dụng mục tiêu ghi nhớ ${Math.round(newRetention * 100)}% vào thuật toán FSRS!`);
        }}
        onShowToast={showToast}
      />

      {/* Rank & Daily Retention Tier Modal */}
      <RankModal
        isOpen={isRankModalOpen}
        onClose={() => setIsRankModalOpen(false)}
        rankData={rankData}
        onStartReview={() => {
          setActiveTab('review');
        }}
      />

      {/* Toast Notification */}
      {toastMessage && (
        <div
          id="toast-notification"
          role="status"
          aria-live="polite"
          className="fixed bottom-24 md:bottom-8 left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-2rem)] bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 pl-3 pr-4 py-2.5 rounded-xl shadow-xl ring-1 ring-white/10 dark:ring-slate-900/10 text-sm font-medium flex items-center gap-2.5 backdrop-blur-md animate-fade-in"
        >
          <CheckCircle2 size={16} className="text-emerald-400 dark:text-emerald-600 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
