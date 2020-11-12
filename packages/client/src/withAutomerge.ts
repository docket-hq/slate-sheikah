import Automerge from 'automerge'

import { Editor } from 'slate'

import { AutomergeEditor } from './automerge-editor'

import { CursorData, CollabAction } from '@slate-sheikah/bridge'

export interface AutomergeOptions {
  docId: string
  cursorData?: CursorData
  preserveExternalHistory?: boolean
  refreshDocOnConnect?: boolean
}

/**
 * The `withAutomerge` plugin contains core collaboration logic.
 */

const withAutomerge = <T extends Editor>(
  editor: T,
  options: AutomergeOptions
) => {
  const e = editor as T & AutomergeEditor

  const { onChange } = e

  const { docId, cursorData, preserveExternalHistory, refreshDocOnConnect } =
    options || {}

  e.docSet = new Automerge.DocSet()

  const createConnection = () => {
    if (e.connection) e.connection.close()

    e.connection = AutomergeEditor.createConnection(e, (data: CollabAction) =>
      //@ts-ignore
      e.send(data)
    )

    e.connection.open()
  }

  createConnection()

  /**
   * Open Automerge Connection
   */

  e.openConnection = () => {
    e.connection.open()
  }

  /**
   * Close Automerge Connection
   */

  e.closeConnection = () => {
    e.connection.close()
  }

  /**
   * Clear cursor data
   */

  e.gabageCursor = () => {
    AutomergeEditor.garbageCursor(e, docId)
  }

  /**
   * Editor onChange
   */

  e.onChange = () => {
    const operations: any = e.operations

    if (!e.isRemote) {
      AutomergeEditor.applySlateOps(e, docId, operations, cursorData)

      onChange()
    }
  }

  /**
   * Receive document value
   */

  e.receiveDocument = data => {
    AutomergeEditor.receiveDocument(e, docId, data, refreshDocOnConnect)

    createConnection()
  }

  /**
   * Receive Automerge sync operations
   */

  e.receiveOperation = data => {
    if (docId !== data.docId) return

    AutomergeEditor.applyOperation(e, docId, data, preserveExternalHistory)
  }

  return e
}

export default withAutomerge
