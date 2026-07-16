import { invoke } from '@tauri-apps/api/core'

export interface NoteSummary {
  id: string
  title: string
  excerpt: string
  isPinned: boolean
  createdAt: number
  updatedAt: number
}

export interface NoteRecord {
  id: string
  title: string
  contentHtml: string
  contentText: string
  isPinned: boolean
  createdAt: number
  updatedAt: number
}

export interface SaveNoteInput {
  id: string
  title: string
  contentHtml: string
  contentText: string
  isPinned: boolean
}

export interface NotesTransferResult {
  path: string
  notes: number
}

export function listNotes(query = '') {
  return invoke<NoteSummary[]>('list_notes', { query })
}

export function getNote(noteId: string) {
  return invoke<NoteRecord | null>('get_note', { noteId })
}

export function createNote(title = '无标题笔记') {
  return invoke<NoteRecord>('create_note', { title })
}

export function saveNote(input: SaveNoteInput) {
  return invoke<NoteRecord>('save_note', { input })
}

export function setNotePinned(noteId: string, isPinned: boolean) {
  return invoke<void>('set_note_pinned', { noteId, isPinned })
}

export function duplicateNote(noteId: string) {
  return invoke<NoteRecord>('duplicate_note', { noteId })
}

export function deleteNote(noteId: string) {
  return invoke<void>('delete_note', { noteId })
}

export function exportNotes(targetPath: string) {
  return invoke<NotesTransferResult>('export_notes', { targetPath })
}

export function importNotes(sourcePath: string) {
  return invoke<NotesTransferResult>('import_notes', { sourcePath })
}

export function writeNoteExport(targetPath: string, content: string) {
  return invoke<string>('write_note_export', { targetPath, content })
}
