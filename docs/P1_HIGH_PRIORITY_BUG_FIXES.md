# P1 (High Priority) ব্যাকএন্ড বাগ ফিক্স প্ল্যান এবং পরিবর্তিত ফাইলসমূহ

ক্লায়েন্টের বাগ রিপোর্ট থেকে চিহ্নিত ৩টি **P1 — High Priority** ব্যাকএন্ড বাগের সংক্ষিপ্ত সমস্যা, সমাধান এবং কোন কোন ফাইলে কী পরিবর্তন করা হয়েছে তার সংক্ষিপ্ত ডকুমেন্টেশন নিচে দেওয়া হলো।

---

## ১. এক নজরে সমাধানকৃত বাগ ও পরিবর্তিত ফাইলসমূহ

| ক্রমিক | বাগ আইডি | সমস্যার সংক্ষিপ্ত বিবরণ | পরিবর্তিত / নতুন ফাইলসমূহ |
| :--- | :--- | :--- | :--- |
| **1** | **SPLIT-023** | Driver My Rides Filter কাজ করছে না (`status`, `type`/`rideType`, `date`, `time` এবং `cancelled` রাইড ফিল্টার) | `server/src/app/modules/ride/ride.service.ts` |
| **2** | **SPLIT-033** | Admin User Block করলেও Push Notification ও রিয়েল-টাইম অ্যালার্ট যাচ্ছে না | `server/src/app/modules/user/user.utils.ts`<br>`server/src/app/modules/user/user.service.ts`<br>`server/src/app/utils/sentPushNotification.ts` |
| **3** | **SPLIT-052** | Ride chat message produces no push (Socket Presence + Push Bypass + Redis Buffer + BullMQ Debounced Batch Push) | `server/src/app/queues/chatPush.queue.ts` *(নতুন)*<br>`server/src/app/socket/handlers/chat/chatPresence.handler.ts` *(নতুন)*<br>`server/src/app/socket/socket.event.ts`<br>`server/src/app/socket/handlers/disconnect.handler.ts`<br>`server/src/app/socket/handlers/chat/sendMessage.handler.ts`<br>`server/src/app/socket/handlers/chat/seen.handler.ts`<br>`server/src/app/modules/messages/message.service.ts`<br>`server/src/server.ts` |

---

## ২. প্রতিটি বাগের সংক্ষিপ্ত বিবরণ ও কোথায় পরিবর্তন হয়েছে

---

### ১. SPLIT-023 — Driver My Rides Filter কাজ করছে না

- **কী বাগ ছিল (Bug)**:
  1. `getDriverRides`-এ স্ট্যাটাস অ্যালিয়াস (`upcoming`/`scheduled`, `ongoing`/`active`, `history`) ম্যাপ করা ছিল না এবং `QueryBuilder.filter()`-এ কাঁচা `query.status` চলে যাওয়ায় কুয়েরি খালি রেজাল্ট দিত।
  2. `cancelled` বা `rejected` রাইডে প্যাসেঞ্জারদের পেমেন্ট স্ট্যাটাস `refunded`/`cancelled_authorization` হওয়ায় পেইড বুকিং চেকের কারণে ক্যানসেলড রাইড কখনোই রিটার্ন হতো না।
  3. `type` বনাম `rideType` (কেস-ইনসেনসিটিভ), `date` বনাম `departureDate` (`DD-MM-YYYY` ও `YYYY-MM-DD`), এবং `time` বনাম `departureTime` (`12h` ও `24h`) ফরম্যাট নরমালাইজ করা ছিল না।

- **কী ফিক্স করা হয়েছে (Fix)**:
  - `resolveRideStatusesFromQuery()`, `normalizeRideTypeValue()`, `buildDateFilterVariants()`, এবং `buildTimeFilterVariants()` হেল্পার যুক্ত করা হয়েছে।
  - `cancelled`/`rejected` রাইডের ক্ষেত্রে রিফান্ডেড বুকিং থাকলেও রাইডটি `eligibleRideIds`-এ অন্তর্ভুক্ত রাখা হয়েছে।
  - `getDriverRides` এবং `getRiderRides` উভয় ফাংশনেই এই নরমালাইজড ফিল্টারিং যুক্ত করা হয়েছে।

- **কোথায় পরিবর্তন হয়েছে (Changed Files)**:
  - `server/src/app/modules/ride/ride.service.ts` (`resolveRideStatusesFromQuery`, `normalizeRideTypeValue`, `buildDateFilterVariants`, `buildTimeFilterVariants`, `getDriverRides`, `getRiderRides`)

---

### ২. SPLIT-033 — Admin User Block করলেও Push Notification যাচ্ছে না

- **কী বাগ ছিল (Bug)**:
  1. `sendUserStatusNotifYToUser`-এ `fcmToken` না থাকলে ইন-অ্যাপ নোটিফিকেশন ও সকেট ইভেন্ট কিছুই যেত না।
  2. `sentPushNotification.ts`-এ Android হাই-প্রায়োরিটি কনফিগারেশন (`priority: 'high'`) ছিল না।
  3. ব্লকড ড্রাইভার অনলাইনে থাকলে তাকে অফলাইনে নেওয়া ও রিয়েল-টাইম সকেট অ্যালার্ট পাঠানো হতো না।

- **কী ফিক্স করা হয়েছে (Fix)**:
  - `sentPushNotification.ts`-এ Android `priority: 'high'` ও ডিফল্ট সাউন্ড যুক্ত করা হয়েছে।
  - `sendUserStatusNotifYToUser`-এ `notifyUserPush` ব্যবহার করে FCM পুশ + নিশ্চিত ইন-অ্যাপ নোটিফিকেশন সেভ + Redis `incrementUnreadCount` + সকেটে `notification`, `notification::<userId>`, ও `user:status-changed` ইভেন্ট পাঠানো হয়েছে।
  - `updateUserStatus`-এ ইউজার `blocked` হলে সাথে সাথে `isOnline: false` করা এবং Redis (`users:online`, `drivers:online`, `drivers:geo`, `drivers:location`) থেকে রিমুভ করা হয়েছে।

- **কোথায় পরিবর্তন হয়েছে (Changed Files)**:
  - `server/src/app/utils/sentPushNotification.ts` (`sendNotification`)
  - `server/src/app/modules/user/user.utils.ts` (`sendUserStatusNotifYToUser`)
  - `server/src/app/modules/user/user.service.ts` (`updateUserStatus`)

---

### ৩. SPLIT-052 — Ride chat message produces no push

- **কী বাগ ছিল (Bug)**:
  - রাইড চলাকালীন চ্যাট মেসেজ পাঠালে রিসিভারের চ্যাট স্ক্রিন প্রেজেন্স ট্র্যাকিং, Redis বাফারিং কিংবা FCM পুশ নোটিফিকেশন পাঠানোর কোনো ব্যবস্থা ছিল না।

- **কী ফিক্স করা হয়েছে (Fix — ৪ ধাপের আর্কিটেকচার)**:
  1. **Socket Presence Tracking**: ক্লায়েন্ট চ্যাট স্ক্রিনে ঢুকলে `join_chat` (বা `join-chat`) এবং বের হলে `leave_chat` (বা `leave-chat`) ফায়ার করলে Redis-এ `chat:active:<chatId>:<userId>` সেভ/ডিলিট হয়। সকেট ডিসকানেক্ট হলেও (`disconnect.handler.ts`) স্বয়ংক্রিয়ভাবে সব অ্যাক্টিভ চ্যাট কী ক্লিয়ার হয়।
  2. **Push Bypass Check**: প্রতিটি নতুন মেসেজে (`send-message` সকেট ও REST API) রিসিভার ওই চ্যাটে অ্যাক্টিভ (`chat:active:<chatId>:<userId>`) থাকলে শুধু সকেটে মেসেজ ডেলিভার হয় এবং FCM পুশ পুরোপুরি স্কিপ করে।
  3. **Redis Buffer & BullMQ Debounce**: রিসিভার চ্যাটে না থাকলে মেসেজটি Redis লিস্ট `chat:buffer:<chatId>:<userId>`-এ পুশ হয় এবং BullMQ `chat-push-queue`-তে ২.৫ সেকেন্ড ডিলে দিয়ে ডিবউন্সড জব (`jobId: batch_<userId>_<chatId>`) শিডিউল হয়।
  4. **Batch Push Dispatch**: ডিলে শেষ হলে ওয়ার্কার (`initChatPushWorker`) Redis থেকে শেষ ৩–৪টি মেসেজের টেক্সট ও মোট আনরিড কাউন্ট নিয়ে একটিমাত্র FCM পুশ পাঠায় এবং বাফার কী ডিলিট করে।

- **কোথায় পরিবর্তন হয়েছে (Changed Files)**:
  - `server/src/app/queues/chatPush.queue.ts` *(নতুন ফাইল)*
  - `server/src/app/socket/handlers/chat/chatPresence.handler.ts` *(নতুন ফাইল)*
  - `server/src/app/socket/socket.event.ts` (`join_chat`, `join-chat`, `leave_chat`, `leave-chat`)
  - `server/src/app/socket/handlers/disconnect.handler.ts` (`clearAllActiveChatsForUser`)
  - `server/src/app/socket/handlers/chat/sendMessage.handler.ts` (`isUserActiveInChat`, `enqueueChatPushNotification`)
  - `server/src/app/socket/handlers/chat/seen.handler.ts` (`clearPendingChatPushBatch`)
  - `server/src/app/modules/messages/message.service.ts` (`createMessages`, `seenMessage`)
  - `server/src/server.ts` (`initChatPushWorker`)

