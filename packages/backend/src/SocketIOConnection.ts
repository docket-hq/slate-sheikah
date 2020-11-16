import io from 'socket.io'
import * as Automerge from 'automerge'
import { Node } from 'slate'
import { Server } from 'http'

import throttle from 'lodash/throttle'

import { SyncDoc, CollabAction, toJS } from '@slate-sheikah/bridge'

import { getClients } from './utils'

import AutomergeBackend from './AutomergeBackend'

export interface SocketIOCollaborationOptions {
  entry: Server
  connectOpts?: SocketIO.ServerOptions
  defaultValue?: Node[]
  saveFrequency?: number
  cleanFrequency?: number
  cleanThreshold?: number
  onAuthRequest?: (
    query: Object,
    socket?: SocketIO.Socket
  ) => Promise<boolean> | boolean
  onDocumentLoad?: (
    pathname: string,
    query?: Object
  ) => Promise<Node[]> | Node[]
  onDocumentSave?: (pathname: string, doc: Node[]) => Promise<void> | void
  onSocketConnection?: (
    socket: SocketIO.Socket,
    backendCounts: BackendCounts[]
  ) => Promise<void> | void
  onSocketDisconnection?: (
    socket: SocketIO.Socket,
    backendCounts: BackendCounts[]
  ) => Promise<void> | void
}
export interface BackendCounts {
  [key: string]: number
}

export interface Backends {
  automerge: AutomergeBackend
  ready: boolean
  failed: boolean
  cleanupTimer: number
}

export default class SocketIOCollaboration {
  private io: SocketIO.Server
  private options: SocketIOCollaborationOptions
  private backends: Backends[] = []
  private backendCounts: BackendCounts[] = []

  /**
   * Constructor
   */

  constructor(options: SocketIOCollaborationOptions) {
    this.io = io(options.entry, {
      ...options.connectOpts,
      perMessageDeflate: true
    })

    this.options = options

    this.configure()

    this.autoSaveDoc = throttle(
      this.saveDocument,
      options.saveFrequency || 2000
    )

    this.backends = []
    this.backendCounts = []
    //spawn cleaner
    setTimeout(() => {
      this.cleaner()
    }, options.cleanFrequency || 60000)

    return this
  }

  /**
   * Initial IO configuration
   */

  private configure = () =>
    this.io
      .of(this.nspMiddleware)
      .use(this.authMiddleware)
      .on('connect', this.onConnect)

  /**
   * Namespace SocketIO middleware. Load document value and append it to CollaborationBackend.
   */

  private nspMiddleware = async (path: string, query: any, next: any) => {
    return next(null, true)
    //this is needed to set up the namespace, but it only runs once.
    //the logic that WAS in here needs to be able to be ran multiple times.
  }

  /**
   * init function to set up new documents is they don't exist.  These get cleaned up once
   * all the sockets disconnect.
   * @param socket
   */
  private init = async (socket: SocketIO.Socket) => {
    const path = socket.nsp.name
    try {
      const query = socket.handshake.query
      const { onDocumentLoad } = this.options

      //make some backends if this is the first time this meeting is loaded.
      if (!this.backends[path]) {
        this.backends[path] = {
          automerge: new AutomergeBackend(),
          ready: false,
          failed: false,
          cleanupTimer:
            Math.floor(Date.now() / 1000) +
            (this.options.cleanThreshold || 30) * 60
        }

        this.backendCounts[path] = 1

        if (!this.backends[path].automerge.getDocument(path)) {
          const doc = onDocumentLoad
            ? await onDocumentLoad(path, query)
            : this.options.defaultValue

          if (doc) {
            this.backends[path].automerge.appendDocument(path, doc)
            this.backends[path].ready = true
          }
        }
      } else {
        this.backendCounts[path] = this.backendCounts[path] + 1
      }
    } catch (e) {
      console.log('Error in slate-collab init', e)
      this.backends[path].failed = true
    }
  }

  /**
   * memory cleaner process that checks the backeds to see if there aren't connections and if the timer has expired.
   */
  private cleaner() {
    console.log('Cleaner running')
    const targets: string[] = []

    try {
      Object.keys(this.backends).forEach(key => {
        if (
          this.backendCounts[key] === 0 &&
          this.backends[key].cleanupTimer < Math.floor(Date.now() / 1000)
        ) {
          targets.push(key)
        }
      })

      console.log(`Found ${targets.length} documents to clean.`)
      if (targets.length) {
        //free up that precious, precious memory.
        targets.forEach(key => {
          delete this.backends[key]
          delete this.io.nsps[key]
          delete this.backendCounts[key]
        })
      }
    } catch (e) {
      console.log('Error freeing memory', e)
    }
    setTimeout(() => {
      this.cleaner()
    }, this.options.cleanFrequency || 60000)
  }

  /**
   * SocketIO auth middleware. Used for user authentification.
   */

  private authMiddleware = async (
    socket: SocketIO.Socket,
    next: (e?: any) => void
  ) => {
    const { query } = socket.handshake
    const { onAuthRequest } = this.options

    if (onAuthRequest) {
      const permit = await onAuthRequest(query, socket)

      if (!permit) return next(new Error(`Authentication error: ${socket.id}`))
    }

    return next()
  }

  /**
   * On 'connect' handler.
   */

  private onConnect = async (socket: SocketIO.Socket) => {
    //if this isn't the first connection and we're not set up yet, delay this for a second.
    const { name } = socket.nsp
    if (this.backends[name] && !this.backends[name].ready) {
      setTimeout(() => {
        this.onConnect(socket)
      }, 1000)
    } else {
      try {
        const { onSocketConnection } = this.options
        const { id, conn } = socket

        await this.init(socket)

        this.backends[name].automerge.createConnection(
          id,
          ({ type, payload }: CollabAction) => {
            socket
              .compress(false)
              .emit('msg', { type, payload: { id: conn.id, ...payload } })
          }
        )

        socket.on('msg', this.onMessage(id, name))

        socket.on('disconnect', this.onDisconnect(id, socket))

        const doc = this.backends[name].automerge.getDocument(name)

        socket.compress(true).emit('msg', {
          type: 'document',
          payload: Automerge.save<SyncDoc>(doc)
        })
        this.backends[name].automerge.openConnection(id)

        this.garbageCursors(name)

        onSocketConnection &&
          (await onSocketConnection(socket, this.backendCounts))
      } catch (e) {
        console.log('Error in slate-collab onConnect', e)
      }
    }
  }

  /**
   * On 'message' handler
   */

  private onMessage = (id: string, name: string) => (data: any) => {
    switch (data.type) {
      case 'operation':
        try {
          this.backends[name].cleanupTimer =
            Math.floor(Date.now() / 1000) +
            (this.options.cleanThreshold || 30) * 60
          this.backends[name].automerge.receiveOperation(id, data)

          this.autoSaveDoc(name)

          this.garbageCursors(name)
        } catch (e) {
          console.log(e)
        }
    }
  }

  private autoSaveDoc = (name: string) => {
    //noop to be overwritten by the constructor.
  }

  /**
   * Save document
   */

  private saveDocument = async (docId: string) => {
    try {
      const { onDocumentSave } = this.options

      //if the backend has already been cleaned up, stop trying to do this.
      if (!this.backends[docId]) {
        return
      }

      const doc = this.backends[docId].automerge.getDocument(docId)

      if (!doc) {
        throw new Error(`Can't receive document by id: ${docId}`)
      }

      onDocumentSave && (await onDocumentSave(docId, toJS(doc.children)))
    } catch (e) {
      console.error(e, docId)
    }
  }

  /**
   * On 'disconnect' handler
   */

  private onDisconnect = (id: string, socket: SocketIO.Socket) => async () => {
    try {
      const { onSocketDisconnection } = this.options

      this.backends[socket.nsp.name].automerge.closeConnection(id)
      this.backendCounts[socket.nsp.name] =
        this.backendCounts[socket.nsp.name] - 1

      await this.saveDocument(socket.nsp.name)

      this.garbageCursors(socket.nsp.name)

      onSocketDisconnection &&
        (await onSocketDisconnection(socket, this.backendCounts))
    } catch (e) {
      console.log('Error in slate-collab onDisconnect', e)
    }
  }

  /**
   * Clean up unused cursor data.
   */

  garbageCursors = (nsp: string) => {
    try {
      const doc = this.backends[nsp].automerge.getDocument(nsp)

      if (!doc.cursors) return

      const namespace = this.io.of(nsp)

      Object.keys(doc?.cursors)?.forEach(key => {
        if (!namespace.sockets[key]) {
          this.backends[nsp].automerge.garbageCursor(nsp, key)
        }
      })
    } catch (e) {
      //don't necessarily care if this fails.
    }
  }

  /**
   * Destroy SocketIO connection
   */

  destroy = async () => {
    this.io.close()
  }
}
