export {
  ChatProvider,
  ChatMessage,
  ChatMessageGroup,
  ChatDateSeparator,
  ChatSystemMessage,
  ChatMessages,
  ChatComposer,
  ChatMessageStatus,
  ChatMessageReactions,
  ChatMessageActions,
  ChatMessageReply,
  ChatTypingIndicator,
  ChatReplyPreview,
  ChatReadReceipts,
  ChatVoiceMessage,
  VOICE_TRACK_BARS,
  ChatFilePreview,
  // Not upstream's exports — added so our own message- and list-shaped components can
  // reuse chatcn's bubble radii and chat context instead of duplicating them.
  // Re-apply after a chatcn re-pull.
  getBubbleRadius,
  useChatContext,
} from "./chat"
export type {
  ChatProviderProps,
  ChatMessageProps,
  ChatMessageGroupProps,
  ChatDateSeparatorProps,
  ChatSystemMessageProps,
  ChatMessagesProps,
  ChatComposerProps,
  ChatMessageActionsProps,
  ChatTypingIndicatorProps,
  ChatReplyPreviewProps,
  FilePreviewItem,
} from "./chat"

// Feature components
export {
  ChatForwardDialog,
  ChatEditComposer,
  ChatDeletedMessage,
  ChatPinnedPanel,
  ChatNestedThread,
  ChatSearch,
} from "./features"
export type {
  Conversation,
  ChatForwardDialogProps,
  ChatEditComposerProps,
  ChatDeletedMessageProps,
  ChatPinnedPanelProps,
  ThreadedMessage,
  ChatNestedThreadProps,
  SearchResult,
  ChatSearchProps,
} from "./features"

// Pre-built layouts
export {
  ChatHeader,
  ChatConversationItem,
  FullMessenger,
  ChatWidget,
  InlineChat,
  ChatBoard,
  LiveChat,
} from "./layouts"
export type {
  ChatHeaderProps,
  SidebarConversation,
  FullMessengerProps,
  ChatWidgetProps,
  InlineChatProps,
  Topic,
  ChatBoardProps,
  LiveChatProps,
} from "./layouts"

// Security utilities
export {
  sanitizeUrl,
  displayHostname,
  stripBidiOverrides,
  truncateMessage,
  sanitizeSenderName,
  validateFile,
  sanitizeFileName,
  isValidEmoji,
  formatReactionCount,
} from "./security"
export type { FileValidationResult } from "./security"

// Types
export type {
  ChatUser,
  ChatMessageData,
  ChatConfig,
  MessageGroup,
  MessageListItem,
  TypingUser,
  ChatTheme,
} from "./types"

// Hooks
export {
  groupMessages,
  useAutoScroll,
  useAutoResize,
  useTypingIndicator,
  formatTimestamp,
  formatDateLabel,
} from "./hooks"
