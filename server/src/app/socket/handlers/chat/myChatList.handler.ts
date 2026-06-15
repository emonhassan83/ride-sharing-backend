import { chatService } from "../../../modules/chat/chat.service"
import { callbackFn } from "../../../utils/callbackFn"
import { TSocket } from "../../interface/index.interface"
import eventHandler from "../../utils/eventHandler"

export const myChatListHandler = eventHandler(
  async (socket: TSocket, _: any, callback: any) => {
    // Find auth to user data
    const userId = socket.auth._id.toString()

    try {
      console.log('📋 my-chat-list event received for userId:', userId)

      const chatList = await chatService.getMyChatList(userId, {})
      console.log('📋 chatList fetched, count:', chatList?.length || 0)

      socket.emit('chat-list', chatList)

      callbackFn(callback, { success: true, data: chatList })
    } catch (err: any) {
      console.error('❌ my-chat-list error:', err.message)
      callbackFn(callback, { success: false, message: err.message })
    }
  },
)
