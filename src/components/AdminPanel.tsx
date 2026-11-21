import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  onAuthStateChanged,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  Check,
  Copy,
  Eye,
  HardDrive,
  Inbox,
  Loader2,
  Lock,
  Mail,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { NEWS_CATEGORIES, getKannadaLocationLabel } from '../data/newsData';
import {
  ADMIN_OWNER_EMAILS,
  auth,
  checkIsAuthorizedAdmin,
  formatReadableFirestoreError,
  googleProvider,
  isAdminOwnerEmail,
} from '../firebase';
import {
  addAdminRecordInFirestore,
  backfillArticleWatermarks,
  createArticleInFirestore,
  deleteArticleInFirestore,
  listAdminRecordsFromFirestore,
  loadInitialArticles,
  loadMoreArticles,
  removeAdminRecordInFirestore,
  removeLegacyFogArticleIfPresent,
  subscribeToArticlesState,
  updateArticleInFirestore,
  type AdminDirectoryEntry,
} from '../services/articlesStore';
import {
  deleteThreadByAdmin,
  loadAdminInboxThreads,
  loadMoreAdminInboxThreads,
  markThreadReadByAdmin,
  sendAdminReply,
  subscribeToThreadMessagesForAdmin,
} from '../services/chatStore';
import {
  backfillEventWatermarks,
  createEventInFirestore,
  deleteEventInFirestore,
  loadInitialEvents,
  loadMoreEvents,
  subscribeToEventsState,
  updateEventInFirestore,
  type EventMutationInput,
} from '../services/eventsStore';
import {
  FIRESTORE_QUOTA_UPGRADE_URL,
  subscribeToQuotaStatus,
  type QuotaStatus,
} from '../services/firestoreOptimizer';
import type {
  FilterCategory,
  NewsArticle,
  ProgramEvent,
  SupportMessage,
  SupportThread,
} from '../types/news';
import { AdminArticleModal, type AdminArticlePayload } from './AdminArticleModal';
import { AdminEventModal } from './AdminEventModal';
import { AdminStorageManager } from './AdminStorageManager';
import { CoffeeCupLogo } from './CoffeeCupLogo';
import { sanitizeRichTextHtml, stripRichTextToPlainText } from '../utils/richText';
import { buildArticlePublicUrl } from '../utils/slug';

interface AdminPanelProps {
  articles: NewsArticle[];
  onNavigateHome: () => void;
}

type AdminTab = 'articles' | 'events' | 'inbox' | 'storage' | 'editors';

export function AdminPanel({ articles, onNavigateHome }: AdminPanelProps) {
  const [user, setUser] = useState<User | null>(() => auth.currentUser);
  const [checkingAuth, setCheckingAuth] = useState<boolean>(true);
  const [isAuthorized, setIsAuthorized] = useState<boolean>(false);
  const [authError, setAuthError] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [signingInWithPassword, setSigningInWithPassword] = useState(false);
  const [verificationMessage, setVerificationMessage] = useState('');
  const [sendingVerification, setSendingVerification] = useState(false);

  // Dashboard state
  const [activeTab, setActiveTab] = useState<AdminTab>('articles');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<FilterCategory>('All');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingArticle, setEditingArticle] = useState<NewsArticle | null>(null);
  const [isSavingArticle, setIsSavingArticle] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [dashboardFeedback, setDashboardFeedback] = useState('');
  const [lastPublishedUrl, setLastPublishedUrl] = useState('');
  const [copiedPublishedUrl, setCopiedPublishedUrl] = useState(false);
  const [dashboardError, setDashboardError] = useState('');

  // Pagination & Quota state
  const [hasMoreArticles, setHasMoreArticles] = useState(false);
  const [loadingArticles, setLoadingArticles] = useState(false);
  const [loadingMoreArticles, setLoadingMoreArticles] = useState(false);
  const [quotaStatus, setQuotaStatus] = useState<QuotaStatus>({
    quotaExceeded: false,
    lastErrorAt: 0,
    cooldownUntil: 0,
    message: '',
  });

  // Programs & Events state (loaded lazily only when Programs & Events tab is opened)
  const [eventsList, setEventsList] = useState<ProgramEvent[]>([]);
  const [hasMoreEvents, setHasMoreEvents] = useState(false);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loadingMoreEvents, setLoadingMoreEvents] = useState(false);
  const [eventModalOpen, setEventModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<ProgramEvent | null>(null);
  const [isSavingEvent, setIsSavingEvent] = useState(false);
  const [confirmDeleteEventId, setConfirmDeleteEventId] = useState<string | null>(null);

  // Reader Inbox & Chat Reply state (loaded lazily only when Inbox tab is opened)
  const [inboxThreads, setInboxThreads] = useState<SupportThread[]>([]);
  const [hasMoreThreads, setHasMoreThreads] = useState(false);
  const [loadingInbox, setLoadingInbox] = useState(false);
  const [loadingMoreThreads, setLoadingMoreThreads] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<SupportMessage[]>([]);
  const [replyText, setReplyText] = useState('');
  const [isSendingReply, setIsSendingReply] = useState(false);
  const [confirmDeleteThreadId, setConfirmDeleteThreadId] = useState<string | null>(null);

  // Editors directory state (for primary owner)
  const [adminsList, setAdminsList] = useState<AdminDirectoryEntry[]>([]);
  const [loadingAdmins, setLoadingAdmins] = useState(false);
  const [newEditorUid, setNewEditorUid] = useState('');
  const [newEditorLabel, setNewEditorLabel] = useState('');
  const [editorMessage, setEditorMessage] = useState('');
  const [editorError, setEditorError] = useState('');
  const [savingEditor, setSavingEditor] = useState(false);
  const [copiedUid, setCopiedUid] = useState(false);

  const isPrimaryOwner =
    Boolean(user?.emailVerified) && isAdminOwnerEmail(user?.email);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setAuthError('');
      if (!nextUser) {
        setIsAuthorized(false);
        setCheckingAuth(false);
        return;
      }

      setCheckingAuth(true);
      try {
        const allowed = await checkIsAuthorizedAdmin(nextUser);
        setIsAuthorized(allowed);
      } catch {
        setIsAuthorized(false);
      } finally {
        setCheckingAuth(false);
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!isAuthorized || !isPrimaryOwner || activeTab !== 'editors') return;
    let cancelled = false;
    setLoadingAdmins(true);
    listAdminRecordsFromFirestore()
      .then((entries) => {
        if (!cancelled) {
          setAdminsList(entries);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setEditorError(formatReadableFirestoreError(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingAdmins(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthorized, isPrimaryOwner, activeTab]);

  const attemptedArticleBackfillRef = useRef<Set<string>>(new Set());
  const attemptedEventBackfillRef = useRef<Set<string>>(new Set());

  // Subscribe to shared in-memory stores & quota status (0 Firestore reads)
  useEffect(() => {
    const unsubArticles = subscribeToArticlesState((state) => {
      setHasMoreArticles(state.hasMore);
    });
    const unsubEvents = subscribeToEventsState((state) => {
      setEventsList(state.events);
      setHasMoreEvents(state.hasMore);
    });
    const unsubQuota = subscribeToQuotaStatus((next) => {
      setQuotaStatus(next);
    });
    return () => {
      unsubArticles();
      unsubEvents();
      unsubQuota();
    };
  }, []);

  // Tab-gated lazy load: fetch ONLY the collection for the active tab (with shared TTL cache)
  useEffect(() => {
    if (!isAuthorized) return;
    let cancelled = false;

    if (activeTab === 'articles') {
      setLoadingArticles(true);
      void loadInitialArticles()
        .finally(() => {
          if (!cancelled) setLoadingArticles(false);
        });
    } else if (activeTab === 'events') {
      setLoadingEvents(true);
      void loadInitialEvents()
        .finally(() => {
          if (!cancelled) setLoadingEvents(false);
        });
    } else if (activeTab === 'inbox') {
      setLoadingInbox(true);
      void loadAdminInboxThreads()
        .then((res) => {
          if (cancelled) return;
          setInboxThreads(res.threads);
          setHasMoreThreads(res.hasMore);
          setSelectedThreadId((prev) => {
            if (prev && res.threads.some((t) => t.id === prev)) return prev;
            return res.threads[0]?.id ?? null;
          });
        })
        .catch((err) => {
          if (!cancelled) setDashboardError(formatReadableFirestoreError(err));
        })
        .finally(() => {
          if (!cancelled) setLoadingInbox(false);
        });
    } else if (activeTab === 'storage') {
      void loadInitialArticles();
      void loadInitialEvents();
    }

    return () => {
      cancelled = true;
    };
  }, [isAuthorized, activeTab]);

  // Automatically purge removed legacy fog news & backfill watermarks once when authorized
  useEffect(() => {
    if (!isAuthorized) return;
    void removeLegacyFogArticleIfPresent();
  }, [isAuthorized]);

  useEffect(() => {
    if (!isAuthorized || activeTab !== 'articles') return;
    const pendingArticles = articles.filter(
      (a) =>
        Boolean(a.imageUrl?.trim()) &&
        !a.watermarkApplied &&
        !attemptedArticleBackfillRef.current.has(a.id)
    );
    if (pendingArticles.length > 0) {
      pendingArticles.forEach((a) => attemptedArticleBackfillRef.current.add(a.id));
      void backfillArticleWatermarks(pendingArticles);
    }
  }, [isAuthorized, activeTab, articles]);

  useEffect(() => {
    if (!isAuthorized || activeTab !== 'events') return;
    const pendingEvents = eventsList.filter(
      (ev) =>
        Boolean(ev.imageUrl?.trim()) &&
        !ev.watermarkApplied &&
        !attemptedEventBackfillRef.current.has(ev.id)
    );
    if (pendingEvents.length > 0) {
      pendingEvents.forEach((ev) => attemptedEventBackfillRef.current.add(ev.id));
      void backfillEventWatermarks(pendingEvents);
    }
  }, [isAuthorized, activeTab, eventsList]);

  // Subscribe to messages ONLY for the currently selected inbox thread while on Inbox tab
  useEffect(() => {
    if (!isAuthorized || activeTab !== 'inbox' || !selectedThreadId) {
      setThreadMessages([]);
      return;
    }
    const unsubMsgs = subscribeToThreadMessagesForAdmin(
      selectedThreadId,
      (msgs) => setThreadMessages(msgs),
      (err) => setDashboardError(formatReadableFirestoreError(err))
    );
    const activeThread = inboxThreads.find((t) => t.id === selectedThreadId);
    if (activeThread?.unreadByAdmin) {
      void markThreadReadByAdmin(selectedThreadId);
    }
    return () => unsubMsgs();
  }, [isAuthorized, activeTab, selectedThreadId, inboxThreads]);

  const unreadInboxCount = useMemo(
    () => inboxThreads.filter((t) => t.unreadByAdmin).length,
    [inboxThreads]
  );

  const selectedThread = useMemo(
    () => inboxThreads.find((t) => t.id === selectedThreadId) ?? null,
    [inboxThreads, selectedThreadId]
  );

  const filteredArticles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return articles.filter((item) => {
      if (categoryFilter !== 'All' && item.category !== categoryFilter) {
        return false;
      }
      if (q) {
        const hay =
          `${stripRichTextToPlainText(item.titleKannada)} ${stripRichTextToPlainText(item.summaryKannada)} ${item.location} ${item.category} ${item.reporter}`.toLowerCase();
        return hay.includes(q);
      }
      return true;
    });
  }, [articles, searchQuery, categoryFilter]);

  const totalArticleViews = useMemo(
    () => articles.reduce((sum, item) => sum + (item.viewCount ?? 0), 0),
    [articles]
  );

  const totalEventViews = useMemo(
    () => eventsList.reduce((sum, ev) => sum + (ev.viewCount ?? 0), 0),
    [eventsList]
  );

  const handleGoogleSignIn = async () => {
    setAuthError('');
    setVerificationMessage('');
    setSigningIn(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to sign in with Google.';
      if (msg.includes('popup-closed-by-user')) {
        setAuthError('Sign-in popup was closed. Please try again.');
      } else {
        setAuthError(msg);
      }
    } finally {
      setSigningIn(false);
    }
  };

  const handleEmailPasswordSignIn = async (e: FormEvent) => {
    e.preventDefault();
    const email = emailInput.trim();
    if (!email || !passwordInput) {
      setAuthError('Please enter both email and password.');
      return;
    }
    setAuthError('');
    setVerificationMessage('');
    setSigningInWithPassword(true);
    try {
      await signInWithEmailAndPassword(auth, email, passwordInput);
      setPasswordInput('');
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/operation-not-allowed') {
        setAuthError(
          'Email/Password login is not enabled in Firebase Authentication yet. Use "Sign in with Google" above, or enable Email/Password in Firebase Console → Authentication → Sign-in method.'
        );
      } else if (
        code === 'auth/invalid-credential' ||
        code === 'auth/wrong-password' ||
        code === 'auth/user-not-found'
      ) {
        setAuthError('Invalid email or password. Make sure the account exists in Firebase Authentication.');
      } else {
        setAuthError(err instanceof Error ? err.message : 'Unable to sign in.');
      }
    } finally {
      setSigningInWithPassword(false);
    }
  };

  const handleSendVerification = async () => {
    if (!user) return;
    setAuthError('');
    setVerificationMessage('');
    setSendingVerification(true);
    try {
      await sendEmailVerification(user);
      setVerificationMessage(
        `Verification email sent to ${user.email}. Click the link in your inbox, then press "I've Verified — Refresh".`
      );
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Failed to send verification email.');
    } finally {
      setSendingVerification(false);
    }
  };

  const handleRefreshVerification = async () => {
    if (!user) return;
    setAuthError('');
    setVerificationMessage('');
    setCheckingAuth(true);
    try {
      await user.reload();
      const refreshedUser = auth.currentUser;
      if (refreshedUser?.emailVerified) {
        await refreshedUser.getIdToken(true);
      }
      setUser(refreshedUser);
      if (refreshedUser) {
        const allowed = await checkIsAuthorizedAdmin(refreshedUser);
        setIsAuthorized(allowed);
        if (!refreshedUser.emailVerified) {
          setAuthError('Email is still not verified. Please click the verification link in your email first.');
        }
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Could not refresh account status.');
    } finally {
      setCheckingAuth(false);
    }
  };

  const handleRefreshSession = async () => {
    const current = auth.currentUser;
    if (!current) return;
    setDashboardError('');
    try {
      await current.reload();
      await current.getIdToken(true);
      const allowed = await checkIsAuthorizedAdmin(current);
      setIsAuthorized(allowed);
      setUser(auth.currentUser);
      setDashboardFeedback('Admin session refreshed. Please try your action again.');
      setLastPublishedUrl('');
    } catch (err) {
      setDashboardError(err instanceof Error ? err.message : 'Could not refresh session.');
    }
  };

  const handleLogout = async () => {
    setDashboardFeedback('');
    setLastPublishedUrl('');
    setDashboardError('');
    setAuthError('');
    setVerificationMessage('');
    await signOut(auth);
  };

  const handleSaveArticle = async (payload: AdminArticlePayload) => {
    if (!user || !isAuthorized) {
      throw new Error('Please sign in with an authorized editor account.');
    }
    setIsSavingArticle(true);
    setDashboardError('');
    setDashboardFeedback('');
    setLastPublishedUrl('');
    setCopiedPublishedUrl(false);
    try {
      let savedArticleId = editingArticle?.id || '';
      if (editingArticle) {
        await updateArticleInFirestore(user.uid, editingArticle.id, payload);
      } else {
        savedArticleId = await createArticleInFirestore(user.uid, payload);
      }

      if (payload.alsoAddToProgram && payload.programDate) {
        const plainTitle = stripRichTextToPlainText(payload.titleKannada);
        const plainSummary = stripRichTextToPlainText(payload.summaryKannada);
        const plainParagraphs = payload.bodyKannada
          .map((part) => stripRichTextToPlainText(part))
          .filter(Boolean);
        const eventDescription = [plainSummary, ...plainParagraphs]
          .filter((part, idx, arr) => part && (idx === 0 || part !== arr[0]))
          .join('\n\n')
          .slice(0, 2000);

        await createEventInFirestore(user.uid, {
          titleKannada: plainTitle,
          descriptionKannada: eventDescription || plainTitle,
          eventDate: payload.programDate,
          eventTime: payload.programTime || '10:00 AM',
          location: payload.location,
          organizer: payload.programOrganizer || payload.reporter || 'Koppa Taluk Committee',
          imageUrl: payload.imageUrl || undefined,
          imageThumbUrl: payload.imageThumbUrl || undefined,
          imageDriveId: payload.imageDriveId || undefined,
          watermarkApplied: payload.watermarkApplied,
        });
      }

      if (savedArticleId) {
        setLastPublishedUrl(buildArticlePublicUrl(savedArticleId));
      }

      setModalOpen(false);
      setEditingArticle(null);
      setDashboardFeedback(
        payload.alsoAddToProgram
          ? editingArticle
            ? 'Article updated and also added to Programs & Events calendar.'
            : 'Published to both News and Programs & Events calendar.'
          : editingArticle
          ? 'Article updated and saved permanently.'
          : 'New article published and saved permanently for all readers.'
      );
    } catch (err) {
      const readable = formatReadableFirestoreError(err);
      setDashboardError(readable);
      throw new Error(readable);
    } finally {
      setIsSavingArticle(false);
    }
  };

  const handleDeleteArticle = async (id: string) => {
    if (!user || !isAuthorized) return;
    setDashboardError('');
    setDashboardFeedback('');
    setLastPublishedUrl('');
    try {
      await deleteArticleInFirestore(user.uid, id);
      setConfirmDeleteId(null);
      setDashboardFeedback('Article deleted from the live feed.');
    } catch (err) {
      setDashboardError(formatReadableFirestoreError(err));
    }
  };

  const handleSaveEvent = async (payload: EventMutationInput) => {
    if (!user || !isAuthorized) {
      throw new Error('Please sign in with an authorized editor account.');
    }
    setIsSavingEvent(true);
    setDashboardError('');
    setDashboardFeedback('');
    try {
      if (editingEvent) {
        await updateEventInFirestore(editingEvent.id, payload);
      } else {
        await createEventInFirestore(user.uid, payload);
      }
      setEventModalOpen(false);
      setEditingEvent(null);
      setDashboardFeedback(
        editingEvent
          ? 'Program/Event updated on the calendar.'
          : 'New Program/Event published and marked green on the calendar.'
      );
    } catch (err) {
      const readable = formatReadableFirestoreError(err);
      setDashboardError(readable);
      throw new Error(readable);
    } finally {
      setIsSavingEvent(false);
    }
  };

  const handleDeleteEvent = async (eventId: string) => {
    if (!user || !isAuthorized) return;
    setDashboardError('');
    setDashboardFeedback('');
    try {
      await deleteEventInFirestore(eventId);
      setConfirmDeleteEventId(null);
      setDashboardFeedback('Program/Event removed from the calendar.');
    } catch (err) {
      setDashboardError(formatReadableFirestoreError(err));
    }
  };

  const handleSendReply = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !isAuthorized || !selectedThreadId || isSendingReply) return;
    const text = replyText.trim();
    if (!text) return;

    setDashboardError('');
    setDashboardFeedback('');
    setIsSendingReply(true);
    try {
      await sendAdminReply({
        threadId: selectedThreadId,
        adminName: user.displayName || user.email || 'Coffeenadu Admin',
        text,
      });
      setInboxThreads((prev) =>
        prev.map((t) =>
          t.id === selectedThreadId
            ? {
                ...t,
                lastMessage: text.slice(0, 1000),
                lastSenderRole: 'admin',
                status: 'replied',
                unreadByAdmin: false,
                unreadByReader: true,
              }
            : t
        )
      );
      setReplyText('');
      setDashboardFeedback('Reply sent to reader.');
    } catch (err) {
      setDashboardError(formatReadableFirestoreError(err));
    } finally {
      setIsSendingReply(false);
    }
  };

  const handleDeleteThread = async (threadId: string) => {
    if (!user || !isAuthorized) return;
    setDashboardError('');
    setDashboardFeedback('');
    try {
      await deleteThreadByAdmin(threadId);
      setInboxThreads((prev) => {
        const next = prev.filter((t) => t.id !== threadId);
        if (selectedThreadId === threadId) {
          setSelectedThreadId(next[0]?.id ?? null);
        }
        return next;
      });
      setConfirmDeleteThreadId(null);
      setDashboardFeedback('Conversation deleted from Inbox.');
    } catch (err) {
      setDashboardError(formatReadableFirestoreError(err));
    }
  };

  const handleRefreshArticles = async () => {
    if (loadingArticles) return;
    setDashboardError('');
    setLoadingArticles(true);
    try {
      await loadInitialArticles({ forceRefresh: true });
    } finally {
      setLoadingArticles(false);
    }
  };

  const handleLoadMoreArticles = async () => {
    if (loadingMoreArticles || !hasMoreArticles) return;
    setLoadingMoreArticles(true);
    try {
      await loadMoreArticles();
    } finally {
      setLoadingMoreArticles(false);
    }
  };

  const handleRefreshEvents = async () => {
    if (loadingEvents) return;
    setDashboardError('');
    setLoadingEvents(true);
    try {
      await loadInitialEvents({ forceRefresh: true });
    } finally {
      setLoadingEvents(false);
    }
  };

  const handleLoadMoreEvents = async () => {
    if (loadingMoreEvents || !hasMoreEvents) return;
    setLoadingMoreEvents(true);
    try {
      await loadMoreEvents();
    } finally {
      setLoadingMoreEvents(false);
    }
  };

  const handleRefreshInbox = async () => {
    if (loadingInbox) return;
    setDashboardError('');
    setLoadingInbox(true);
    try {
      const res = await loadAdminInboxThreads({ forceRefresh: true });
      setInboxThreads(res.threads);
      setHasMoreThreads(res.hasMore);
    } catch (err) {
      setDashboardError(formatReadableFirestoreError(err));
    } finally {
      setLoadingInbox(false);
    }
  };

  const handleLoadMoreInbox = async () => {
    if (loadingMoreThreads || !hasMoreThreads) return;
    setLoadingMoreThreads(true);
    try {
      const res = await loadMoreAdminInboxThreads(inboxThreads);
      setInboxThreads(res.threads);
      setHasMoreThreads(res.hasMore);
    } catch (err) {
      setDashboardError(formatReadableFirestoreError(err));
    } finally {
      setLoadingMoreThreads(false);
    }
  };

  const handleAddEditor = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !isPrimaryOwner) return;
    setEditorError('');
    setEditorMessage('');
    setSavingEditor(true);
    try {
      await addAdminRecordInFirestore(user.uid, newEditorUid, newEditorLabel);
      setNewEditorUid('');
      setNewEditorLabel('');
      setEditorMessage('Authorized editor added.');
      const updated = await listAdminRecordsFromFirestore();
      setAdminsList(updated);
    } catch (err) {
      setEditorError(formatReadableFirestoreError(err));
    } finally {
      setSavingEditor(false);
    }
  };

  const handleRemoveEditor = async (targetUid: string) => {
    if (!user || !isPrimaryOwner) return;
    setEditorError('');
    setEditorMessage('');
    try {
      await removeAdminRecordInFirestore(targetUid);
      setAdminsList((prev) => prev.filter((item) => item.uid !== targetUid));
      setEditorMessage('Editor access removed.');
    } catch (err) {
      setEditorError(formatReadableFirestoreError(err));
    }
  };

  const handleCopyOwnUid = async () => {
    if (!user?.uid) return;
    try {
      await navigator.clipboard.writeText(user.uid);
      setCopiedUid(true);
      window.setTimeout(() => setCopiedUid(false), 2000);
    } catch {
      // Ignore clipboard failures
    }
  };

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-[#FBFBF9] flex items-center justify-center p-4">
        <p className="text-sm font-medium text-stone-600">Verifying editorial session...</p>
      </div>
    );
  }

  // Unauthenticated or unauthorized screen
  if (!user || !isAuthorized) {
    return (
      <div className="min-h-screen bg-[#FBFBF9] flex flex-col">
        <header className="bg-white border-b border-stone-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
            <button
              type="button"
              onClick={onNavigateHome}
              className="inline-flex items-center gap-2 font-masthead text-xl font-extrabold tracking-tight text-[#0F274A] whitespace-nowrap shrink-0 cursor-pointer"
            >
              <CoffeeCupLogo className="w-7 h-7 shrink-0" />
              <span>Coffeenadu News</span>
            </button>
            <button
              type="button"
              onClick={onNavigateHome}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-stone-700 hover:text-emerald-900 cursor-pointer whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              <span>Back to Public Site</span>
            </button>
          </div>
        </header>

        <main className="flex-1 flex items-center justify-center px-4 py-12">
          <div className="w-full max-w-md bg-white border border-stone-200 rounded-lg p-6 sm:p-8 shadow-sm">
            <div className="flex items-center gap-2.5 mb-2">
              <Lock className="w-4 h-4 text-emerald-900" aria-hidden="true" />
              <span className="text-xs font-semibold uppercase tracking-wider text-emerald-900">
                Editorial Access
              </span>
            </div>

            {!user ? (
              <>
                <h1 className="text-2xl font-bold text-stone-950 mb-1">Admin Sign In</h1>
                <p className="text-sm text-stone-600 mb-6">
                  Sign in with your authorized Google account from mobile or PC to publish Koppa Taluk news permanently.
                </p>

                {authError && (
                  <div
                    role="alert"
                    className="mb-4 px-3.5 py-2.5 text-xs font-medium text-red-800 bg-red-50 border border-red-200 rounded-md"
                  >
                    {authError}
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  disabled={signingIn || signingInWithPassword}
                  className="w-full py-3 px-4 text-sm font-semibold text-white bg-[#0F274A] hover:bg-[#173a6e] disabled:opacity-60 rounded-md transition-colors cursor-pointer min-h-[44px]"
                >
                  {signingIn ? 'Signing in...' : 'Sign in with Google'}
                </button>

                <div className="my-5 flex items-center gap-3">
                  <div className="h-px flex-1 bg-stone-200" />
                  <span className="text-[11px] font-medium uppercase tracking-wider text-stone-400">
                    or email &amp; password
                  </span>
                  <div className="h-px flex-1 bg-stone-200" />
                </div>

                <form onSubmit={handleEmailPasswordSignIn} className="space-y-3">
                  <div>
                    <label htmlFor="admin-email" className="block text-xs font-semibold text-stone-700 mb-1">
                      Admin Email
                    </label>
                    <input
                      id="admin-email"
                      type="email"
                      autoComplete="email"
                      required
                      value={emailInput}
                      onChange={(e) => setEmailInput(e.target.value)}
                      placeholder="owner@gmail.com"
                      className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-md text-stone-900 focus:outline-none focus:border-emerald-800 min-h-[40px]"
                    />
                  </div>
                  <div>
                    <label htmlFor="admin-password" className="block text-xs font-semibold text-stone-700 mb-1">
                      Password
                    </label>
                    <input
                      id="admin-password"
                      type="password"
                      autoComplete="current-password"
                      required
                      value={passwordInput}
                      onChange={(e) => setPasswordInput(e.target.value)}
                      placeholder="Enter your Firebase password"
                      className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-md text-stone-900 focus:outline-none focus:border-emerald-800 min-h-[40px]"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={signingIn || signingInWithPassword}
                    className="w-full py-2.5 px-4 text-sm font-semibold text-stone-800 bg-stone-100 hover:bg-stone-200 disabled:opacity-60 rounded-md transition-colors cursor-pointer min-h-[42px]"
                  >
                    {signingInWithPassword ? 'Signing in...' : 'Sign in with Email'}
                  </button>
                </form>
              </>
            ) : !user.emailVerified ? (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <Mail className="w-4 h-4 text-amber-700" aria-hidden="true" />
                  <h1 className="text-xl font-bold text-stone-950">Email Verification Required</h1>
                </div>
                <p className="text-sm text-stone-600 mb-4">
                  Signed in as <strong className="text-stone-900">{user.email}</strong>, but this account&apos;s email is not verified yet. Firestore rules require a verified email before publishing.
                </p>

                {authError && (
                  <div
                    role="alert"
                    className="mb-3 px-3.5 py-2.5 text-xs font-medium text-red-800 bg-red-50 border border-red-200 rounded-md"
                  >
                    {authError}
                  </div>
                )}

                {verificationMessage && (
                  <div
                    role="status"
                    className="mb-3 px-3.5 py-2.5 text-xs font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-md"
                  >
                    {verificationMessage}
                  </div>
                )}

                <div className="space-y-2.5">
                  <button
                    type="button"
                    onClick={handleSendVerification}
                    disabled={sendingVerification}
                    className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-emerald-900 hover:bg-emerald-800 disabled:opacity-60 rounded-md transition-colors cursor-pointer min-h-[44px]"
                  >
                    {sendingVerification ? 'Sending link...' : 'Send Verification Email'}
                  </button>
                  <button
                    type="button"
                    onClick={handleRefreshVerification}
                    className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-[#0F274A] hover:bg-[#173a6e] rounded-md transition-colors cursor-pointer min-h-[44px]"
                  >
                    I&apos;ve Verified — Refresh
                  </button>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="w-full py-2.5 px-4 text-sm font-semibold text-stone-800 bg-stone-100 hover:bg-stone-200 rounded-md transition-colors cursor-pointer min-h-[44px]"
                  >
                    Switch Account / Use Google Sign-In
                  </button>
                </div>
              </>
            ) : (
              <>
                <h1 className="text-2xl font-bold text-stone-950 mb-1">Access Required</h1>
                <p className="text-sm text-stone-600 mb-4">
                  Signed in as <strong className="text-stone-900">{user.email}</strong>, which is not yet authorized as a Coffeenadu News editor.
                </p>
                <div className="mb-5 p-3 bg-stone-50 border border-stone-200 rounded-md space-y-2">
                  <p className="text-xs text-stone-600">
                    Share this Editor UID with a site owner ({ADMIN_OWNER_EMAILS.join(' or ')}) to grant publishing access, or switch accounts:
                  </p>
                  <div className="flex items-center justify-between gap-2 bg-white border border-stone-200 rounded px-2.5 py-1.5">
                    <code className="text-[11px] text-stone-800 break-all">{user.uid}</code>
                    <button
                      type="button"
                      onClick={handleCopyOwnUid}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-[#0F274A] shrink-0 cursor-pointer"
                    >
                      {copiedUid ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-700" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="w-full py-2.5 px-4 text-sm font-semibold text-stone-800 bg-stone-100 hover:bg-stone-200 rounded-md transition-colors cursor-pointer min-h-[44px]"
                >
                  Switch Account
                </button>
              </>
            )}
          </div>
        </main>
      </div>
    );
  }

  // Authenticated & authorized /admin management dashboard
  return (
    <div className="min-h-screen flex flex-col bg-[#FBFBF9] text-stone-900">
      <header className="sticky top-0 z-40 bg-white border-b border-stone-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
          <button
            type="button"
            onClick={() => setActiveTab('articles')}
            className="inline-flex items-center gap-2 font-masthead text-xl sm:text-2xl font-extrabold tracking-tight text-[#0F274A] whitespace-nowrap shrink-0 cursor-pointer"
          >
            <CoffeeCupLogo className="w-7 h-7 shrink-0" />
            <span>Coffeenadu Admin</span>
          </button>

          <nav aria-label="Admin sections" className="hidden md:flex items-center gap-6">
            <button
              type="button"
              onClick={() => setActiveTab('articles')}
              className={`text-sm font-medium whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors cursor-pointer ${
                activeTab === 'articles'
                  ? 'border-emerald-800 text-stone-950'
                  : 'border-transparent text-stone-600 hover:text-stone-950'
              }`}
            >
              Manage News
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('events')}
              className={`inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors cursor-pointer ${
                activeTab === 'events'
                  ? 'border-emerald-800 text-stone-950'
                  : 'border-transparent text-stone-600 hover:text-stone-950'
              }`}
            >
              <CalendarDays className="w-4 h-4" aria-hidden="true" />
              <span>Programs &amp; Events</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('inbox')}
              className={`inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors cursor-pointer ${
                activeTab === 'inbox'
                  ? 'border-emerald-800 text-stone-950'
                  : 'border-transparent text-stone-600 hover:text-stone-950'
              }`}
            >
              <Inbox className="w-4 h-4" aria-hidden="true" />
              <span>Inbox{unreadInboxCount > 0 ? ` (${unreadInboxCount})` : ''}</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('storage')}
              className={`inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors cursor-pointer ${
                activeTab === 'storage'
                  ? 'border-emerald-800 text-stone-950'
                  : 'border-transparent text-stone-600 hover:text-stone-950'
              }`}
            >
              <HardDrive className="w-4 h-4" aria-hidden="true" />
              <span>Storage &amp; Backups</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('editors')}
              className={`text-sm font-medium whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors cursor-pointer ${
                activeTab === 'editors'
                  ? 'border-emerald-800 text-stone-950'
                  : 'border-transparent text-stone-600 hover:text-stone-950'
              }`}
            >
              Editorial Access
            </button>
            <button
              type="button"
              onClick={onNavigateHome}
              className="text-sm font-medium text-stone-600 hover:text-stone-950 whitespace-nowrap shrink-0 py-1 border-b-2 border-transparent cursor-pointer"
            >
              View Public Site
            </button>
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handleLogout}
              className="px-4 py-2 text-xs sm:text-sm font-semibold text-stone-800 bg-stone-100 hover:bg-stone-200 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer min-h-[40px]"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Tab Strip */}
      <div className="md:hidden bg-white border-b border-stone-200 px-4 py-2 flex items-center gap-2 overflow-x-auto">
        <button
          type="button"
          onClick={() => setActiveTab('articles')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
            activeTab === 'articles' ? 'bg-emerald-900 text-white' : 'bg-stone-100 text-stone-700'
          }`}
        >
          Manage News
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('events')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
            activeTab === 'events' ? 'bg-emerald-900 text-white' : 'bg-stone-100 text-stone-700'
          }`}
        >
          Programs &amp; Events
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('inbox')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
            activeTab === 'inbox' ? 'bg-emerald-900 text-white' : 'bg-stone-100 text-stone-700'
          }`}
        >
          Inbox{unreadInboxCount > 0 ? ` (${unreadInboxCount})` : ''}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('storage')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
            activeTab === 'storage' ? 'bg-emerald-900 text-white' : 'bg-stone-100 text-stone-700'
          }`}
        >
          Storage &amp; Backups
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('editors')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
            activeTab === 'editors' ? 'bg-emerald-900 text-white' : 'bg-stone-100 text-stone-700'
          }`}
        >
          Editorial Access
        </button>
        <button
          type="button"
          onClick={onNavigateHome}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-stone-100 text-stone-700 whitespace-nowrap shrink-0"
        >
          View Public Site
        </button>
      </div>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {quotaStatus.quotaExceeded && (
          <div
            role="status"
            className="mb-6 px-4 py-3.5 bg-amber-50 border border-amber-300 rounded-md flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs sm:text-sm text-amber-950"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="space-y-0.5">
                <p className="font-bold text-amber-950">
                  Firebase Daily Free Read Limit Reached
                </p>
                <p className="text-xs text-amber-900">
                  Showing cached news and events so your portal stays online. Free daily read quota resets automatically tomorrow, or you can review quota usage in Firebase Console.
                </p>
              </div>
            </div>
            <a
              href={FIRESTORE_QUOTA_UPGRADE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 text-xs font-semibold text-amber-950 bg-white border border-amber-300 hover:bg-amber-100 rounded whitespace-nowrap self-start sm:self-center shrink-0"
            >
              View Quota in Firebase →
            </a>
          </div>
        )}

        {activeTab === 'articles' ? (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-stone-200">
              <div>
                <h1 className="text-2xl font-bold text-stone-950">Koppa Taluk News Desk</h1>
                <p className="text-xs text-stone-500 mt-1">
                  Signed in as <span className="font-semibold text-stone-800">{user.email}</span> ·{' '}
                  <span className="tabular-nums">{articles.length}</span> loaded articles ·{' '}
                  <span className="font-semibold text-[#0F274A] tabular-nums">
                    {totalArticleViews.toLocaleString()} total article views
                  </span>
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleRefreshArticles}
                  disabled={loadingArticles}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs sm:text-sm font-semibold text-stone-700 bg-white border border-stone-200 hover:bg-stone-50 disabled:opacity-60 rounded-md transition-colors cursor-pointer min-h-[44px]"
                >
                  <RefreshCw
                    className={`w-4 h-4 ${loadingArticles ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  <span>Refresh</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingArticle(null);
                    setModalOpen(true);
                  }}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-emerald-900 hover:bg-emerald-800 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 min-h-[44px]"
                >
                  <Plus className="w-4 h-4" aria-hidden="true" />
                  <span>Add News</span>
                </button>
              </div>
            </div>

            {dashboardFeedback && (
              <div
                role="status"
                className="px-4 py-3 text-xs sm:text-sm font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-md space-y-2"
              >
                <p>{dashboardFeedback}</p>
                {lastPublishedUrl && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-emerald-800">Published URL:</span>
                    <a
                      href={lastPublishedUrl}
                      className="font-semibold text-[#0F274A] underline break-all"
                    >
                      {lastPublishedUrl}
                    </a>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(lastPublishedUrl);
                          setCopiedPublishedUrl(true);
                          setTimeout(() => setCopiedPublishedUrl(false), 2500);
                        } catch {
                          // Ignore clipboard denial
                        }
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-emerald-900 bg-white border border-emerald-300 hover:bg-emerald-100 rounded cursor-pointer"
                    >
                      {copiedPublishedUrl ? (
                        <>
                          <Check className="w-3 h-3" aria-hidden="true" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" aria-hidden="true" />
                          <span>Copy Link</span>
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}

            {dashboardError && (
              <div
                role="alert"
                className="px-4 py-3 text-xs sm:text-sm font-medium text-red-800 bg-red-50 border border-red-200 rounded-md flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
              >
                <span>{dashboardError}</span>
                {dashboardError.toLowerCase().includes('permission') && (
                  <button
                    type="button"
                    onClick={handleRefreshSession}
                    className="px-3 py-1.5 text-xs font-semibold text-red-900 bg-white border border-red-300 hover:bg-red-100 rounded cursor-pointer self-start sm:self-auto shrink-0"
                  >
                    Refresh Session
                  </button>
                )}
              </div>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="relative flex-1">
                <Search
                  className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search articles by Kannada headline, town, or reporter..."
                  className="w-full pl-9 pr-4 py-2 text-sm bg-white border border-stone-200 rounded-md text-stone-900 placeholder:text-stone-400 focus:outline-none focus:border-emerald-800 min-h-[40px]"
                />
              </div>

              <select
                aria-label="Filter by category"
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value as FilterCategory)}
                className="px-3 py-2 text-sm bg-white border border-stone-200 rounded-md text-stone-800 focus:outline-none focus:border-emerald-800 min-h-[40px]"
              >
                <option value="All">All Categories</option>
                {NEWS_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>

            <div className="bg-white border border-stone-200 rounded-md divide-y divide-stone-200">
              {filteredArticles.length === 0 ? (
                <div className="p-8 text-center text-sm text-stone-500">
                  No articles match your current filter.
                </div>
              ) : (
                filteredArticles.map((article) => {
                  const isConfirming = confirmDeleteId === article.id;
                  return (
                    <div
                      key={article.id}
                      className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4"
                    >
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
                          <span className="font-semibold text-emerald-900 uppercase tracking-wider">
                            {article.category}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-kannada">{getKannadaLocationLabel(article.location)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{article.publishedDate}</span>
                          <span aria-hidden="true">·</span>
                          <span>{article.reporter}</span>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1 font-semibold text-[#0F274A] tabular-nums">
                            <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>{(article.viewCount ?? 0).toLocaleString()} views</span>
                          </span>
                          {article.isFeatured && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-semibold text-amber-800">Lead Story</span>
                            </>
                          )}
                        </div>

                        <h2
                          className="article-rich-content article-rich-inline-compact font-kannada text-base sm:text-lg font-bold text-stone-950 leading-snug"
                          dangerouslySetInnerHTML={{ __html: sanitizeRichTextHtml(article.titleKannada) }}
                        />
                        <div
                          className="article-rich-content article-rich-inline-compact font-kannada text-xs sm:text-sm text-stone-600 line-clamp-1"
                          dangerouslySetInnerHTML={{ __html: sanitizeRichTextHtml(article.summaryKannada) }}
                        />
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingArticle(article);
                            setModalOpen(true);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-stone-800 bg-stone-100 hover:bg-stone-200 rounded-md transition-colors cursor-pointer min-h-[40px]"
                        >
                          <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Edit</span>
                        </button>

                        {isConfirming ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleDeleteArticle(article.id)}
                              className="px-3 py-2 text-xs font-semibold text-white bg-red-700 hover:bg-red-800 rounded-md transition-colors cursor-pointer min-h-[40px]"
                            >
                              Confirm Delete
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-3 py-2 text-xs font-medium text-stone-700 bg-stone-100 hover:bg-stone-200 rounded-md transition-colors cursor-pointer min-h-[40px]"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(article.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 rounded-md transition-colors cursor-pointer min-h-[40px]"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Delete</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            {hasMoreArticles && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={handleLoadMoreArticles}
                  disabled={loadingMoreArticles}
                  className="px-4 py-2 text-xs font-semibold text-[#0F274A] bg-white border border-stone-300 hover:bg-stone-50 rounded-md cursor-pointer disabled:opacity-60 min-h-[40px]"
                >
                  {loadingMoreArticles ? 'Loading more articles...' : 'Load More Articles'}
                </button>
              </div>
            )}
          </div>
        ) : activeTab === 'events' ? (
          /* Programs & Events Schedule Manager */
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-stone-200">
              <div>
                <h1 className="text-2xl font-bold text-stone-950">Programs &amp; Events Calendar</h1>
                <p className="text-xs text-stone-500 mt-1">
                  <span className="tabular-nums">{eventsList.length}</span> loaded programs ·{' '}
                  <span className="font-semibold text-[#0F274A] tabular-nums">
                    {totalEventViews.toLocaleString()} total program views
                  </span>{' '}
                  · Scheduled dates turn green on the public calendar
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleRefreshEvents}
                  disabled={loadingEvents}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs sm:text-sm font-semibold text-stone-700 bg-white border border-stone-200 hover:bg-stone-50 disabled:opacity-60 rounded-md transition-colors cursor-pointer min-h-[44px]"
                >
                  <RefreshCw
                    className={`w-4 h-4 ${loadingEvents ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  <span>Refresh</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingEvent(null);
                    setEventModalOpen(true);
                  }}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-emerald-900 hover:bg-emerald-800 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 min-h-[44px]"
                >
                  <Plus className="w-4 h-4" aria-hidden="true" />
                  <span>Add Program / Event</span>
                </button>
              </div>
            </div>

            {dashboardFeedback && (
              <div
                role="status"
                className="px-4 py-3 text-xs sm:text-sm font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-md"
              >
                {dashboardFeedback}
              </div>
            )}

            {dashboardError && (
              <div
                role="alert"
                className="px-4 py-3 text-xs sm:text-sm font-medium text-red-800 bg-red-50 border border-red-200 rounded-md"
              >
                {dashboardError}
              </div>
            )}

            <div className="bg-white border border-stone-200 rounded-md divide-y divide-stone-200">
              {eventsList.length === 0 ? (
                <div className="p-8 text-center text-sm text-stone-500">
                  No programs or events scheduled yet. Click &ldquo;Add Program / Event&rdquo; to schedule one.
                </div>
              ) : (
                eventsList.map((ev) => {
                  const isConfirming = confirmDeleteEventId === ev.id;
                  return (
                    <div
                      key={ev.id}
                      className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4"
                    >
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-stone-600">
                          <span className="font-bold text-emerald-800 tabular-nums">{ev.eventDate}</span>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums font-medium">{ev.eventTime}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-kannada font-medium">{getKannadaLocationLabel(ev.location)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{ev.organizer}</span>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1 font-semibold text-[#0F274A] tabular-nums">
                            <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>{(ev.viewCount ?? 0).toLocaleString()} views</span>
                          </span>
                        </div>
                        <h2 className="font-kannada text-base sm:text-lg font-bold text-stone-950">
                          {ev.titleKannada}
                        </h2>
                        <p className="font-kannada text-xs sm:text-sm text-stone-600 line-clamp-2">
                          {ev.descriptionKannada}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingEvent(ev);
                            setEventModalOpen(true);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-stone-800 bg-stone-100 hover:bg-stone-200 rounded-md transition-colors cursor-pointer min-h-[40px]"
                        >
                          <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Edit</span>
                        </button>

                        {isConfirming ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleDeleteEvent(ev.id)}
                              className="px-3 py-2 text-xs font-semibold text-white bg-red-700 hover:bg-red-800 rounded-md cursor-pointer min-h-[40px]"
                            >
                              Confirm Delete
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteEventId(null)}
                              className="px-3 py-2 text-xs font-medium text-stone-700 bg-stone-100 hover:bg-stone-200 rounded-md cursor-pointer min-h-[40px]"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteEventId(ev.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 rounded-md cursor-pointer min-h-[40px]"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Delete</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            {hasMoreEvents && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={handleLoadMoreEvents}
                  disabled={loadingMoreEvents}
                  className="px-4 py-2 text-xs font-semibold text-[#0F274A] bg-white border border-stone-300 hover:bg-stone-50 rounded-md cursor-pointer disabled:opacity-60 min-h-[40px]"
                >
                  {loadingMoreEvents ? 'Loading more programs...' : 'Load More Programs'}
                </button>
              </div>
            )}
          </div>
        ) : activeTab === 'inbox' ? (
          /* Reader Messages Inbox & Real-Time Reply */
          <div className="space-y-5">
            <div className="pb-4 border-b border-stone-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h1 className="text-2xl font-bold text-stone-950">Reader Inbox · ಸಂದೇಶಗಳು</h1>
                <p className="text-xs text-stone-500 mt-1">
                  Messages sent by readers from the public chat appear here. Replies sync live back to the reader.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-stone-600 tabular-nums">
                  {inboxThreads.length} conversations · {unreadInboxCount} unread
                </span>
                <button
                  type="button"
                  onClick={handleRefreshInbox}
                  disabled={loadingInbox}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-stone-700 bg-white border border-stone-200 hover:bg-stone-50 disabled:opacity-60 rounded-md cursor-pointer"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${loadingInbox ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  <span>Refresh</span>
                </button>
              </div>
            </div>

            {dashboardFeedback && (
              <div
                role="status"
                className="px-4 py-3 text-xs sm:text-sm font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-md"
              >
                {dashboardFeedback}
              </div>
            )}

            {dashboardError && (
              <div
                role="alert"
                className="px-4 py-3 text-xs sm:text-sm font-medium text-red-800 bg-red-50 border border-red-200 rounded-md"
              >
                {dashboardError}
              </div>
            )}

            {loadingInbox && inboxThreads.length === 0 ? (
              <div className="bg-white border border-stone-200 rounded-lg p-8 text-center text-sm text-stone-500">
                Loading reader conversations...
              </div>
            ) : inboxThreads.length === 0 ? (
              <div className="bg-white border border-stone-200 rounded-lg p-8 text-center text-sm text-stone-500">
                No reader messages yet. When a reader uses the Message button on the site, their chat appears here.
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                {/* Thread List */}
                <div className="lg:col-span-5 bg-white border border-stone-200 rounded-lg divide-y divide-stone-200 max-h-[600px] overflow-y-auto">
                  {inboxThreads.map((thread) => {
                    const isSelected = thread.id === selectedThreadId;
                    return (
                      <button
                        key={thread.id}
                        type="button"
                        onClick={() => {
                          setSelectedThreadId(thread.id);
                          setConfirmDeleteThreadId(null);
                        }}
                        className={`w-full text-left p-4 transition-colors cursor-pointer space-y-1.5 ${
                          isSelected ? 'bg-emerald-50/70' : 'hover:bg-stone-50'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-bold text-sm text-stone-950 font-kannada truncate">
                              {thread.senderName}
                            </span>
                            {thread.unreadByAdmin && (
                              <span className="text-[11px] font-bold text-emerald-800 uppercase">
                                · New
                              </span>
                            )}
                          </div>
                          {thread.senderLocation && (
                            <span className="text-[11px] text-stone-500 font-kannada shrink-0">
                              {getKannadaLocationLabel(thread.senderLocation)}
                            </span>
                          )}
                        </div>
                        {thread.senderPhone && (
                          <p className="text-[11px] font-medium text-emerald-800 inline-flex items-center gap-1 tabular-nums">
                            <Phone className="w-3 h-3 shrink-0" aria-hidden="true" />
                            <span>{thread.senderPhone}</span>
                          </p>
                        )}
                        <p className="text-[11px] font-semibold text-[#0F274A] font-kannada truncate">
                          {thread.topic}
                        </p>
                        <p className="text-xs text-stone-600 font-kannada line-clamp-2">
                          {thread.lastMessage}
                        </p>
                      </button>
                    );
                  })}
                  {hasMoreThreads && (
                    <div className="p-3 text-center">
                      <button
                        type="button"
                        onClick={handleLoadMoreInbox}
                        disabled={loadingMoreThreads}
                        className="px-3 py-1.5 text-xs font-semibold text-[#0F274A] bg-stone-50 hover:bg-stone-100 border border-stone-200 rounded cursor-pointer disabled:opacity-60"
                      >
                        {loadingMoreThreads ? 'Loading...' : 'Load More Conversations'}
                      </button>
                    </div>
                  )}
                </div>

                {/* Selected Conversation & Reply Box */}
                <div className="lg:col-span-7 bg-white border border-stone-200 rounded-lg overflow-hidden flex flex-col">
                  {selectedThread ? (
                    <>
                      <div className="px-5 py-3.5 bg-stone-50 border-b border-stone-200 flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0 space-y-0.5">
                          <h2 className="text-sm font-bold text-stone-950 font-kannada">
                            {selectedThread.senderName}
                            {selectedThread.senderLocation
                              ? ` · ${getKannadaLocationLabel(selectedThread.senderLocation)}`
                              : ''}
                          </h2>
                          {selectedThread.senderPhone && (
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <a
                                href={`tel:${selectedThread.senderPhone.replace(/[^\d+]/g, '')}`}
                                className="inline-flex items-center gap-1 font-semibold text-emerald-800 hover:underline tabular-nums"
                              >
                                <Phone className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>{selectedThread.senderPhone}</span>
                              </a>
                              <a
                                href={`https://wa.me/${selectedThread.senderPhone.replace(/\D/g, '').length === 10 ? `91${selectedThread.senderPhone.replace(/\D/g, '')}` : selectedThread.senderPhone.replace(/\D/g, '')}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2 py-0.5 rounded"
                              >
                                WhatsApp Reply
                              </a>
                            </div>
                          )}
                          <p className="text-xs text-stone-600 font-kannada">
                            {selectedThread.topic}
                          </p>
                        </div>

                        {confirmDeleteThreadId === selectedThread.id ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleDeleteThread(selectedThread.id)}
                              className="px-3 py-1.5 text-xs font-semibold text-white bg-red-700 hover:bg-red-800 rounded cursor-pointer"
                            >
                              Confirm Delete
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteThreadId(null)}
                              className="px-3 py-1.5 text-xs font-medium text-stone-700 bg-stone-200 rounded cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteThreadId(selectedThread.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 rounded cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Delete Chat</span>
                          </button>
                        )}
                      </div>

                      <div className="p-5 space-y-3 max-h-[380px] min-h-[240px] overflow-y-auto bg-[#FBFBF9]">
                        {threadMessages.map((msg) => {
                          const isAdminMsg = msg.senderRole === 'admin';
                          return (
                            <div
                              key={msg.id}
                              className={`flex ${isAdminMsg ? 'justify-end' : 'justify-start'}`}
                            >
                              <div
                                className={`max-w-[85%] rounded-lg px-4 py-2.5 text-sm space-y-1 ${
                                  isAdminMsg
                                    ? 'bg-[#0F274A] text-white'
                                    : 'bg-white border border-stone-200 text-stone-900'
                                }`}
                              >
                                <div
                                  className={`flex items-center justify-between gap-4 text-[11px] font-semibold ${
                                    isAdminMsg ? 'text-amber-300' : 'text-emerald-900'
                                  }`}
                                >
                                  <span>{msg.senderName}</span>
                                  {msg.createdTimestamp && (
                                    <span className="tabular-nums opacity-80">
                                      {new Date(msg.createdTimestamp).toLocaleTimeString('en-IN', {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                      })}
                                    </span>
                                  )}
                                </div>
                                <p className="font-kannada whitespace-pre-wrap break-words leading-relaxed">
                                  {msg.text}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <form onSubmit={handleSendReply} className="p-4 border-t border-stone-200 bg-white flex flex-col sm:flex-row gap-2.5">
                        <textarea
                          rows={2}
                          maxLength={2000}
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          placeholder="Write reply to reader (English or Kannada)..."
                          className="flex-1 px-3 py-2 text-sm font-kannada bg-white border border-stone-300 rounded-md text-stone-900 focus:outline-none focus:border-emerald-800"
                        />
                        <button
                          type="submit"
                          disabled={isSendingReply || !replyText.trim()}
                          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-emerald-900 hover:bg-emerald-800 disabled:opacity-50 rounded-md cursor-pointer shrink-0 min-h-[44px]"
                        >
                          {isSendingReply ? (
                            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <Send className="w-4 h-4" aria-hidden="true" />
                          )}
                          <span>Send Reply</span>
                        </button>
                      </form>
                    </>
                  ) : (
                    <div className="p-8 text-center text-sm text-stone-500">
                      Select a conversation on the left to read and reply.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : activeTab === 'storage' ? (
          <AdminStorageManager
            currentArticles={articles}
            currentEvents={eventsList}
            onDataChanged={async () => {
              await Promise.all([
                loadInitialArticles({ forceRefresh: true }),
                loadInitialEvents({ forceRefresh: true }),
              ]);
            }}
          />
        ) : (
          /* Editorial Access Tab */
          <div className="max-w-xl bg-white border border-stone-200 rounded-lg p-6 sm:p-8 space-y-6">
            <div className="flex items-start gap-3">
              <ShieldCheck className="w-5 h-5 text-emerald-900 mt-0.5 shrink-0" aria-hidden="true" />
              <div>
                <h1 className="text-xl font-bold text-stone-950">Editorial Access</h1>
                <p className="text-xs text-stone-600 mt-1">
                  Signed in with Google as <strong className="text-stone-900">{user.email}</strong>.
                  All published news and photos are synced in Cloud Firestore across mobile and PC.
                </p>
              </div>
            </div>

            {isPrimaryOwner ? (
              <>
                {editorMessage && (
                  <div
                    role="status"
                    className="px-3.5 py-2.5 text-xs font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-md"
                  >
                    {editorMessage}
                  </div>
                )}

                {editorError && (
                  <div
                    role="alert"
                    className="px-3.5 py-2.5 text-xs font-medium text-red-800 bg-red-50 border border-red-200 rounded-md"
                  >
                    {editorError}
                  </div>
                )}

                <form onSubmit={handleAddEditor} className="space-y-3 pt-2 border-t border-stone-200">
                  <h2 className="text-sm font-bold text-stone-900 flex items-center gap-2">
                    <UserPlus className="w-4 h-4 text-emerald-900" aria-hidden="true" />
                    <span>Authorize Additional Editor</span>
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input
                      type="text"
                      required
                      value={newEditorLabel}
                      onChange={(e) => setNewEditorLabel(e.target.value)}
                      placeholder="Editor name (e.g. Koppa Desk)"
                      className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-md text-stone-900 focus:outline-none focus:border-emerald-800 min-h-[40px]"
                    />
                    <input
                      type="text"
                      required
                      value={newEditorUid}
                      onChange={(e) => setNewEditorUid(e.target.value)}
                      placeholder="Firebase User UID"
                      className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-md text-stone-900 focus:outline-none focus:border-emerald-800 min-h-[40px]"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={savingEditor}
                    className="px-4 py-2 text-xs font-semibold text-white bg-emerald-900 hover:bg-emerald-800 disabled:opacity-60 rounded-md transition-colors cursor-pointer min-h-[40px]"
                  >
                    {savingEditor ? 'Authorizing...' : 'Add Editor'}
                  </button>
                </form>

                <div className="pt-4 border-t border-stone-200 space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-500">
                    Authorized Co-Editors
                  </h3>
                  {loadingAdmins ? (
                    <p className="text-xs text-stone-500">Loading editors...</p>
                  ) : adminsList.length === 0 ? (
                    <p className="text-xs text-stone-500">
                      Only the admin owners ({ADMIN_OWNER_EMAILS.join(', ')}) are currently authorized.
                    </p>
                  ) : (
                    <div className="divide-y divide-stone-200 border border-stone-200 rounded-md">
                      {adminsList.map((entry) => (
                        <div key={entry.uid} className="p-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-stone-900">{entry.label}</p>
                            <code className="text-[11px] text-stone-500 break-all">{entry.uid}</code>
                          </div>
                          {entry.uid !== user.uid && (
                            <button
                              type="button"
                              onClick={() => handleRemoveEditor(entry.uid)}
                              className="px-2.5 py-1.5 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 rounded cursor-pointer shrink-0"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-stone-600">
                Your UID (<code className="text-stone-800">{user.uid}</code>) is authorized by the primary editorial owner.
              </p>
            )}
          </div>
        )}
      </main>

      <AdminArticleModal
        isOpen={modalOpen}
        editingArticle={editingArticle}
        existingArticleIds={articles.map((a) => a.id)}
        isSaving={isSavingArticle}
        onClose={() => {
          setModalOpen(false);
          setEditingArticle(null);
        }}
        onSubmit={handleSaveArticle}
      />

      <AdminEventModal
        isOpen={eventModalOpen}
        editingEvent={editingEvent}
        isSaving={isSavingEvent}
        onClose={() => {
          setEventModalOpen(false);
          setEditingEvent(null);
        }}
        onSubmit={handleSaveEvent}
      />
    </div>
  );
}
