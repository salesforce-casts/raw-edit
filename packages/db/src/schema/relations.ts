import { relations } from 'drizzle-orm';
import { account, session, user } from './auth.js';
import { uploadSession, video, videoSource } from './video.js';
import {
  detectedTake,
  detectedTakeMember,
  processingJob,
  transcript,
  transcriptSegment,
  transcriptWord,
} from './processing.js';
import { editDecision, editSettings, shareLink, videoExport } from './editing.js';
import { subscription, usageRecord, userSettings } from './billing.js';

export const userRelations = relations(user, ({ many, one }) => ({
  sessions: many(session),
  accounts: many(account),
  videos: many(video),
  settings: one(userSettings, { fields: [user.id], references: [userSettings.userId] }),
  subscription: one(subscription, { fields: [user.id], references: [subscription.userId] }),
  usage: many(usageRecord),
}));

export const videoRelations = relations(video, ({ many, one }) => ({
  owner: one(user, { fields: [video.userId], references: [user.id] }),
  source: one(videoSource, { fields: [video.id], references: [videoSource.videoId] }),
  uploadSession: one(uploadSession, { fields: [video.id], references: [uploadSession.videoId] }),
  jobs: many(processingJob),
  transcript: one(transcript, { fields: [video.id], references: [transcript.videoId] }),
  segments: many(transcriptSegment),
  takes: many(detectedTake),
  decisions: many(editDecision),
  settings: one(editSettings, { fields: [video.id], references: [editSettings.videoId] }),
  exports: many(videoExport),
  shareLinks: many(shareLink),
}));

export const transcriptRelations = relations(transcript, ({ many, one }) => ({
  video: one(video, { fields: [transcript.videoId], references: [video.id] }),
  segments: many(transcriptSegment),
}));

export const transcriptSegmentRelations = relations(transcriptSegment, ({ many, one }) => ({
  transcript: one(transcript, { fields: [transcriptSegment.transcriptId], references: [transcript.id] }),
  words: many(transcriptWord),
}));

export const detectedTakeRelations = relations(detectedTake, ({ many, one }) => ({
  video: one(video, { fields: [detectedTake.videoId], references: [video.id] }),
  members: many(detectedTakeMember),
}));

export const exportRelations = relations(videoExport, ({ many, one }) => ({
  video: one(video, { fields: [videoExport.videoId], references: [video.id] }),
  shareLinks: many(shareLink),
}));

export const shareLinkRelations = relations(shareLink, ({ one }) => ({
  video: one(video, { fields: [shareLink.videoId], references: [video.id] }),
  export: one(videoExport, { fields: [shareLink.exportId], references: [videoExport.id] }),
}));
