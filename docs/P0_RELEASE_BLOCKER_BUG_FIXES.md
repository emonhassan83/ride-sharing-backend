# P0 (Release Blocker) ব্যাকএন্ড বাগ ফিক্স রিপোর্ট এবং ডকুমেন্টেশন

ক্লায়েন্টের বাগ রিপোর্ট (`Split_Ride_Developer_Bug_Report.pdf`) থেকে চিহ্নিত ১১টি **P0 — Release Blocker** ব্যাকএন্ড ইস্যুর বিস্তারিত সমস্যা (What Was the Bug), সমাধান (What Was Fixed), এবং কোন কোন ফাইলে কী পরিবর্তন করা হয়েছে (Where Changes Were Made) তার পূর্ণাঙ্গ ডকুমেন্টেশন নিচে দেওয়া হলো।

---

## ১. এক নজরে সমাধানকৃত বাগ ও পরিবর্তিত ফাইলসমূহ

| ক্রমিক | বাগ আইডি | সমস্যার সংক্ষিপ্ত বিবরণ | পরিবর্তিত / নতুন ফাইলসমূহ |
| :--- | :--- | :--- | :--- |
| **a** | **SPLIT-015** | লগআউটের পরেও পুশ নোটিফিকেশন যাওয়া এবং সময়ের আগেই (২৫ মিনিটে) Split-to-Solo কনভার্সন হওয়া | `server/src/app/modules/auth/auth.service.ts`<br>`server/src/app/job/splitRidePendingMatch.job.ts` |
| **b** | **SPLIT-042** | রাইড রিকোয়েস্ট পাঠালে অতিরিক্ত ড্রাইভারের (২৩–২৮ জন) কাছে নোটিফিকেশন যাওয়া | `server/src/app/utils/notifyDrivers.utils.ts`<br>`server/src/app/modules/payment/payment.service.ts`<br>`server/src/app/job/noDriverFound.job.ts`<br>`server/src/app/job/splitRidePendingMatch.job.ts` |
| **c** | **SPLIT-045** | অফলাইন ড্রাইভারের কাছে রাইড ইনভাইটেশন ও পুশ নোটিফিকেশন যাওয়া | `server/src/app/utils/notifyDrivers.utils.ts` |
| **d** | **SPLIT-051** | যাত্রীর অনুমতি (OTP ভেরিফিকেশন) ছাড়াই ড্রাইভার রাইড শুরু করতে পারা | `server/src/app/utils/rideStartOtp.utils.ts` *(নতুন)*<br>`server/src/app/modules/passenger/passenger.interface.ts`<br>`server/src/app/modules/passenger/passenger.model.ts`<br>`server/src/app/modules/ride/ride.routes.ts`<br>`server/src/app/modules/ride/ride.controller.ts`<br>`server/src/app/modules/ride/ride.service.ts`<br>`server/src/app/socket/socket.event.ts`<br>`server/src/app/socket/handlers/ride/driverStartTrip.handler.ts`<br>`server/src/app/socket/handlers/ride/driverArrivedClean.handler.ts` *(নতুন)*<br>`server/src/app/socket/handlers/ride/pickUpRideClean.handler.ts` *(নতুন)*<br>`server/src/app/socket/utils/triggerArrival.ts` |
| **e** | **SPLIT-058** | রিয়েল-টাইম রিকোয়েস্ট না আসা, অ্যাপ ওপেন করলে অফলাইন হয়ে যাওয়া এবং অফলাইনেও রাইড অ্যাক্সেপ্ট হওয়া | `server/src/app/socket/socket.init.ts`<br>`server/src/app/socket/handlers/disconnect.handler.ts`<br>`server/src/app/socket/handlers/ride/driverAcceptRide.handler.ts`<br>`server/src/app/utils/notifyDrivers.utils.ts` |
| **f** | **SPLIT-061** | প্রাইভেট রাইড ডিসপ্যাচ কাজ না করা (কাছাকাছি অনলাইন ড্রাইভার রিকোয়েস্ট না পাওয়া) | `server/src/app/utils/notifyDrivers.utils.ts`<br>`server/src/app/modules/payment/payment.service.ts` |
| **g** | **SPLIT-062** | ডিলিট করা ড্রাইভার অ্যাকাউন্ট পুনরায় খুললে পুরনো ডাটা ও KYC ফিরে আসা | `server/src/app/modules/user/user.service.ts`<br>`server/src/app/modules/auth/auth.service.ts` |
| **h** | **SPLIT-063** | অ্যাপ রিস্টার্ট না দেওয়া পর্যন্ত ড্রাইভারের কাছে রিয়েল-টাইমে রাইড রিকোয়েস্ট না আসা | `server/src/app/socket/socket.init.ts`<br>`server/src/app/socket/handlers/disconnect.handler.ts`<br>`server/src/app/utils/notifyDrivers.utils.ts` |
| **i** | **SPLIT-064** | স্প্লিট রাইড ম্যাচ পাওয়ার পর অটো-রিফান্ড হয়ে যাওয়া এবং পরে আবার রাইড কমপ্লিট ও পেইড দেখানো | `server/src/app/socket/handlers/ride/driverAcceptRide.handler.ts`<br>`server/src/app/job/noDriverFound.job.ts`<br>`server/src/app/utils/splitFare.utils.ts`<br>`server/src/app/socket/handlers/ride/driverCompleteTrip.handler.ts` |
| **j** | **SPLIT-065** | যাত্রীকে পিকআপ করার আগেই "Your ride has started" নোটিফিকেশন চলে যাওয়া | `server/src/app/socket/handlers/ride/driverStartTrip.handler.ts`<br>`server/src/app/socket/handlers/ride/pickUpRideClean.handler.ts`<br>`server/src/app/utils/rideStartOtp.utils.ts` |
| **k** | **SPLIT-070** | প্রথম ড্রাইভার রাইড অ্যাক্সেপ্ট করার পর সেই স্প্লিট রাইডটি অন্য যাত্রীদের সার্চে আর না পাওয়া যাওয়া | `server/src/app/socket/handlers/ride/findNearBySplitRide.handler.ts`<br>`server/src/app/socket/handlers/ride/splitRideRequest.handler.ts`<br>`server/src/app/socket/handlers/ride/driverAcceptRide.handler.ts`<br>`server/src/app/utils/splitFare.utils.ts` |

---

## ২. প্রতিটি বাগের বিস্তারিত বিবরণ, ফিক্স এবং পরিবর্তিত স্থান

---

### a. SPLIT-015 | Push sent after logout and split-to-solo conversion too early

#### কী বাগ ছিল (What Was the Bug):
1. ইউজার লগআউট করার পর বা একই ফোনে অন্য অ্যাকাউন্টে লগইন করার পরও আগের অ্যাকাউন্টে থাকা একই `fcmToken` মুছে যাচ্ছিল না এবং লগআউটের সময় ইউজারের সকেট রুম ও Redis অনলাইন স্ট্যাটাস পরিষ্কার করা হচ্ছিল না। ফলে লগআউটের পরেও পুশ নোটিফিকেশন আসছিল।
2. `splitRidePendingMatch.job.ts`-এ শুধুমাত্র `hoursUntilDeparture <= releaseHours` (১ ঘণ্টা) চেক করা হচ্ছিল; রাইডটি কতক্ষণ ধরে স্প্লিট ম্যাচিং সার্চ করেছে (`hoursSinceCreated`) তা চেক করা হচ্ছিল না। ফলে ১ ঘণ্টা ২৫ মিনিট পরের রাইড বুক করলে মাত্র ২৫ মিনিট পরেই Solo কনভার্সন পুশ চলে যাচ্ছিল।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- লগইন ও রেজিস্ট্রেশনের সময় `clearFcmTokenFromOtherUsers()` চালিয়ে ওই `fcmToken` অন্য কোনো ইউজারের ডকুমেন্টে থাকলে তা `null` করে দেওয়া হয়েছে।
- `logoutUser()`-এ ডাটাবেজে `fcmToken: null` ও `isOnline: false` করার পাশাপাশি Redis (`users:online`, `drivers:location`, `driver:${uid}:details`) এবং সক্রিয় সকেট রুম (`user:${uid}`, `driver:${uid}`) থেকে ইউজারকে বিচ্ছিন্ন করা হয়েছে।
- `splitRidePendingMatch.job.ts`-এ চেক যুক্ত করা হয়েছে যেন রাইড বুকিংয়ের পর ন্যূনতম সার্চ সময় (`hoursSinceCreated >= releaseHours` অথবা পিকআপের ১৫ মিনিট আগে `hoursUntilDeparture <= 0.25`) পূর্ণ না হওয়া পর্যন্ত Solo কনভার্সন না হয়।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/modules/auth/auth.service.ts` (`clearFcmTokenFromOtherUsers`, `createUser`, `registerWithGoogle`, `registerWithApple`, `loginWithEmail`, `loginWithPhone`, `logoutUser`)
- `server/src/app/job/splitRidePendingMatch.job.ts` (`processSplitMatchingBacklog`)

---

### b. SPLIT-042 | Driver notification recipient count appears excessive (23–28 drivers notified)

#### কী বাগ ছিল (What Was the Bug):
- `payment.service.ts`, `noDriverFound.job.ts`, এবং `splitRidePendingMatch.job.ts` থেকে `notifyNearbyDrivers` কল করার সময় `{ notifyMode: 'all_eligible' }` পাঠানো হচ্ছিল।
- `notifyDrivers.utils.ts`-এ `all_eligible` মোডে কোনো লোকেশন রেডিয়াস বা অনলাইন চেক ছাড়াই ডাটাবেজের **সকল KYC-verified ড্রাইভারকে (২৩–২৮ জন)** নোটিফাই করা হচ্ছিল এবং অফলাইন ড্রাইভারদেরও কাউন্ট করা হচ্ছিল।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- `all_eligible` ব্রডকাস্ট এবং অফলাইন ড্রাইভার কুয়েরি সম্পূর্ণ রিমুভ করা হয়েছে।
- এখন শুধুমাত্র পিকআপ লোকেশনের নির্দিষ্ট রেডিয়াসের (`radiusKm`, যেমন ১০ কি.মি. প্রাইভেট ও ১৫ কি.মি. স্প্লিট রাইডের রুট করিডোর) মধ্যে থাকা **অনলাইন (`isOnline: true`)** ও এলিজিবল ড্রাইভারদের নোটিফাই করা হয় এবং সঠিক `notifiedCount` রিটার্ন করা হয়।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/utils/notifyDrivers.utils.ts` (`notifyNearbyDrivers`, `notifyNearbyDriversForSplitRide`, `emitNewRideRequestToDriver`)
- `server/src/app/modules/payment/payment.service.ts` (`startRideMatchingAfterPayment`)
- `server/src/app/job/noDriverFound.job.ts` (`checkNoDriverFound`)
- `server/src/app/job/splitRidePendingMatch.job.ts` (`releaseUnmatchedSplitToSolo`)

---

### c. SPLIT-045 | Offline driver receives ride invitation

#### কী বাগ ছিল (What Was the Bug):
- `notifyDrivers.utils.ts`-এ অনলাইন ড্রাইভারদের পাশাপাশি MongoDB থেকে অফলাইন ড্রাইভারদেরও (`offlineDrivers`) কুয়েরি করে পুশ নোটিফিকেশন পাঠানো হচ্ছিল এবং `notifiedDriverIds`-এ যুক্ত করা হচ্ছিল।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- `notifyNearbyDrivers`, `notifyNearbyDriversForSplitRide` এবং `emitNewRideRequestToDriver`-এ কঠোরভাবে `driver.isOnline === true`, `!driver.isDeleted`, `driver.status === 'active'`, এবং `driver.isKycVerified === true` যাচাই নিশ্চিত করা হয়েছে। অফলাইন ড্রাইভারের কাছে এখন কোনো রাইড রিকোয়েস্ট বা পুশ যাবে না।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/utils/notifyDrivers.utils.ts`

---

### d. SPLIT-051 | Ride can start without passenger authorization (Ride Start OTP API & Flow)

#### কী বাগ ছিল (What Was the Bug):
- ড্রাইভার যাত্রীর কাছ থেকে কোনো OTP ভেরিফাই করা ছাড়াই যেকোনো সময় (`driver:start-trip` বা `driver:pickup-ride`) রাইড শুরু করে দিতে পারত।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- `Passenger` মডেলে `isStartOtpVerified: { type: Boolean, default: false }` ফিল্ড যুক্ত করা হয়েছে।
- রাইড শুরু করার জন্য নতুন OTP জেনারেশন ও ভেরিফিকেশন সিস্টেম তৈরি করা হয়েছে:
  1. **`POST /api/v1/ride/send-start-otp`** (এবং সকেট ইভেন্ট `driver:send-start-otp`):
     - রিকোয়েস্ট বডি: `{ "rideId": "<rideId>", "passengerId": "<optional_passengerId>" }`
     - কাজ: ৪-ডিজিটের OTP জেনারেট করে Redis-এ ১০ মিনিটের মেয়াদে সেভ করে এবং যাত্রীর **Push Notification**, **Email** ও **Socket (`ride:start-otp`)**-এ পাঠায়। এছাড়া ড্রাইভার পিকআপ লোকেশনে পৌঁছালে (`triggerArrival` / `driver:arrived-pickup`) স্বয়ংক্রিয়ভাবেও OTP চলে যায়।
  2. **`POST /api/v1/ride/verify-start-otp`** (এবং সকেট ইভেন্ট `driver:verify-start-otp`):
     - রিকোয়েস্ট বডি: `{ "rideId": "<rideId>", "passengerId": "<optional_passengerId>", "otp": "1234" }`
     - কাজ: OTP সঠিক হলে `passenger.isStartOtpVerified = true` করে এবং সকেটে `ride:start-otp-verified` ইভেন্ট পাঠায়।
  3. `driver:start-trip` এবং `driver:pickup-ride`-এ চেক বসানো হয়েছে—যাত্রীর OTP ভেরিফাই না হওয়া পর্যন্ত রাইড স্টার্ট হবে না (এবং OTP ভেরিফাই ছাড়া স্টার্ট করতে চাইলে স্বয়ংক্রিয়ভাবে যাত্রীর কাছে OTP পাঠিয়ে `requiresOtp: true` রেসপন্স দেবে)।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/utils/rideStartOtp.utils.ts` *(নতুন ফাইল)*
- `server/src/app/modules/passenger/passenger.interface.ts`
- `server/src/app/modules/passenger/passenger.model.ts`
- `server/src/app/modules/ride/ride.routes.ts`
- `server/src/app/modules/ride/ride.controller.ts`
- `server/src/app/modules/ride/ride.service.ts`
- `server/src/app/socket/socket.event.ts`
- `server/src/app/socket/handlers/ride/driverStartTrip.handler.ts`
- `server/src/app/socket/handlers/ride/driverArrivedClean.handler.ts` *(নতুন ফাইল)*
- `server/src/app/socket/handlers/ride/pickUpRideClean.handler.ts` *(নতুন ফাইল)*
- `server/src/app/socket/utils/triggerArrival.ts`

---

### e. SPLIT-058 এবং h. SPLIT-063 | Missing real-time requests, unexpected offline switch, and requests only arriving after app restart

#### কী বাগ ছিল (What Was the Bug):
1. `socket.init.ts` এবং `disconnect.handler.ts`—উভয় জায়গায় `disconnect` ইভেন্ট রেজিস্টার করা ছিল এবং ড্রাইভার অ্যাপ সামান্য সময়ের জন্য ব্যাকগ্রাউন্ডে গেলে বা রিকানেক্ট হলে সাথে সাথে ডাটাবেজে `isOnline: false` করে দেওয়া হতো ও Redis থেকে `users:online` ও `drivers:location` মুছে ফেলা হতো।
2. সকেট রিকানেক্ট হলে ড্রাইভার `driver:${userId}` রুমে জয়েন করলেও Redis-এর `users:online` সেটে যুক্ত হতো না। ফলে `emitNewRideRequestToDriver`-এ `redis.sismember('users:online', driverId)` মিথ্যা (`0`) হওয়ায় সকেটে `ride:new-request` ইভেন্ট যেত না; অ্যাপ রিস্টার্ট দিলে কেবল REST API থেকে রিকোয়েস্ট লোড হতো।
3. `driverAcceptRide.handler.ts`-এ ডাটাবেজে ড্রাইভার অফলাইন থাকা সত্ত্বেও `isOnline` চেক না করে রাইড অ্যাক্সেপ্ট করতে দেওয়া হচ্ছিল।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- `socket.init.ts` থেকে ডুপ্লিকেট `disconnect` লিসেনার সরানো হয়েছে এবং `disconnect.handler.ts`-এ সকেট ডিসকানেক্ট হলেই ড্রাইভারকে অফলাইন (`isOnline: false`) করে দেওয়া বন্ধ করা হয়েছে (ড্রাইভার কেবল `driver:go-offline` বা `logout` করলেই অফলাইন হবে)।
- সকেট কানেক্ট/রিকানেক্ট হওয়ার সময় (`socket.init.ts`) ডাটাবেজে ড্রাইভার `isOnline: true` থাকলে স্বয়ংক্রিয়ভাবে Redis-এর `users:online`, `drivers:location`, এবং `driver:${userId}:details` রিস্টোর করা হয়েছে।
- `emitNewRideRequestToDriver`-এ অনলাইন ড্রাইভারকে সরাসরি `driver:${driverId}` ও `user:${driverId}` রুমে রিয়েল-টাইম `ride:new-request` পাঠানো নিশ্চিত করা হয়েছে।
- `driverAcceptRide.handler.ts`-এ ডাটাবেজে `!driverUserCheck.isOnline` হলে রাইড অ্যাক্সেপ্ট ব্লক করা হয়েছে।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/socket/socket.init.ts`
- `server/src/app/socket/handlers/disconnect.handler.ts`
- `server/src/app/socket/handlers/ride/driverAcceptRide.handler.ts`
- `server/src/app/utils/notifyDrivers.utils.ts`

---

### f. SPLIT-061 | Private ride dispatch not working

#### কী বাগ ছিল (What Was the Bug):
1. `notifyDrivers.utils.ts`-এর `privateMatchingDriverIds` ফাংশনে ৪-সিটার রাইডের জন্য শুধুমাত্র `isDefault: true` এবং `seats: { $gte: 4, $lte: 5 }` শর্ত দেওয়া ছিল। ফলে ৬-সিটার গাড়ি বা ডিফল্ট ফ্ল্যাগ না থাকা গাড়ির ড্রাইভাররা বাদ পড়ে যাচ্ছিল।
2. সকেট রিকানেকশনে Redis `drivers:location` থেকে ড্রাইভার মুছে গেলে ডাটাবেজে অনলাইন থাকা সত্ত্বেও তাকে খুঁজে পাওয়া যাচ্ছিল না।
3. প্রাইভেট রাইডে ইউজার নির্দিষ্ট ড্রাইভার সিলেক্ট করলে (`selectedDriverId`), পেমেন্ট কনফার্ম হওয়ার পর `startRideMatchingAfterPayment`-এ সেই `selectedDriverId` পাস করা হচ্ছিল না।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- `privateMatchingDriverIds`-এ ৪-সিটার রাইডের জন্য `{ $gte: 4 }` (যেকোনো ৪ বা ততোধিক সিটের অ্যাক্টিভ গাড়ি) গ্রহণ করার ব্যবস্থা করা হয়েছে।
- `notifyNearbyDrivers`-এ Redis `drivers:location`-এর পাশাপাশি ডাটাবেজে `isOnline: true` থাকা নির্দিষ্ট রেডিয়াসের (`$nearSphere`) ড্রাইভারদেরও অন্তর্ভুক্ত করা হয়েছে।
- `payment.service.ts`-এ Redis থেকে `selectedDriverId` পড়ে `notifyNearbyDrivers`-এ পাস করা হয়েছে।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/utils/notifyDrivers.utils.ts`
- `server/src/app/modules/payment/payment.service.ts`

---

### g. SPLIT-062 | Deleted driver account resurrected with old data

#### কী বাগ ছিল (What Was the Bug):
- অ্যাকাউন্ট ডিলিট (`deleteUserProfile`) করার সময় শুধুমাত্র `User.isDeleted = true` করা হতো, কিন্তু `Provider` (KYC রেকর্ড), `Vehicle`, `UserLocation`, `Notification` ডিলিট করা হতো না এবং ইউজারের প্রোফাইল ফিল্ডগুলো রিসেট করা হতো না।
- পরবর্তীতে একই ইমেইল/ফোন দিয়ে আবার সাইনআপ করলে পুরনো ইউজার ডকুমেন্টটিই `isDeleted: false` হয়ে পুরনো ছবি, KYC স্ট্যাটাস ও গাড়ির তথ্যসহ ফিরে আসত।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- ইউজারকে **সফট-ডিলিট (`isDeleted: true`)** রেখে তার সব প্রোফাইল ও KYC ফিল্ড (`profileImage: null`, `address: null`, `type: null`, `isKycVerified: false`, `isProfileComplete: false`, `documents: null`, `status: 'pending'`) রিসেট করা হয়েছে।
- ইউজারের সাথে সম্পর্কিত সব রিলেশন ডাটা (`Provider.deleteMany`, `Vehicle.deleteMany`, `UserLocation.deleteMany`, `Notification.deleteMany` এবং Redis cache) সম্পূর্ণ রিমুভ করা হয়েছে—ডিলিট করার সময় এবং পুনরায় রেজিস্ট্রেশন (`createUser`, `registerWithGoogle`, `registerWithApple`) করার সময় উভয় ক্ষেত্রেই।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/modules/user/user.service.ts` (`deleteUserProfile`)
- `server/src/app/modules/auth/auth.service.ts` (`purgeDeletedUserRelations`, `createUser`, `registerWithGoogle`, `registerWithApple`)

---

### i. SPLIT-064 | Split ride marked found, automatically refunded, then completed/paid

#### কী বাগ ছিল (What Was the Bug):
1. স্প্লিট রাইডে একাধিক যাত্রী থাকলে ড্রাইভার যখন ১ম যাত্রীকে অ্যাক্সেপ্ট করত (`driverAcceptRide.handler.ts`), তখন অন্য যাত্রী `pending` থাকার কারণে `isLastPassenger === false` হতো এবং `ride.status` ভুলবশত `'pending'`-ই থেকে যেত!
2. পিকআপের সময় হলেই `noDriverFound.job.ts` শুধুমাত্র `status: 'pending'` দেখে (`driverId: null` চেক না করেই) ধরে নিত রাইডে কোনো ড্রাইভার পাওয়া যায়নি এবং সাথে সাথে পুরো রাইডের সব বুকিং ক্যানসেল ও রিফান্ড করে দিত!
3. কিন্তু ১ম যাত্রীর স্ট্যাটাস `confirmed` থাকায় ড্রাইভার পরে ট্রিপটি স্টার্ট ও কমপ্লিট করত, যা আবার বুকিংকে `completed` এবং পেমেন্টকে `paid` করে দিত। এছাড়া `recalculateSplitFares`-এ পেমেন্ট `pending` থাকলেও ভুলবশত রিফান্ড রেকর্ড তৈরি হতো।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- `driverAcceptRide.handler.ts`-এ স্প্লিট রাইডে ড্রাইভার প্রথম যাত্রীকে অ্যাক্সেপ্ট করার সাথে সাথেই `rideUpdate.status = RIDE_STATUS.accepted` সেট করা হয়েছে এবং `ride:matching:queue` থেকে রাইডটি সরিয়ে ফেলা হয়েছে।
- `noDriverFound.job.ts`-এ নিশ্চিত করা হয়েছে যে কেবল `driverId: null` এবং কোনো `confirmed`/`in_progress` যাত্রী না থাকলেই রাইড `no_driver_found` হিসেবে ক্যানসেল হবে।
- `splitFare.utils.ts`-এ শুধুমাত্র পেইড (`status === 'paid'`) পেমেন্টের ক্ষেত্রেই ভাড়া কমলে রিফান্ড তৈরি হওয়া নিশ্চিত করা হয়েছে।
- `driverCompleteTrip.handler.ts`-এ ক্যানসেল হওয়া বুকিং যেন ওভাররাইট না হয় তার গার্ড যুক্ত করা হয়েছে।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/socket/handlers/ride/driverAcceptRide.handler.ts`
- `server/src/app/job/noDriverFound.job.ts`
- `server/src/app/utils/splitFare.utils.ts`
- `server/src/app/socket/handlers/ride/driverCompleteTrip.handler.ts`

---

### j. SPLIT-065 | Ride-start notification fires before pickup

#### কী বাগ ছিল (What Was the Bug):
- ড্রাইভার পিকআপ লোকেশনে পৌঁছানোর বা যাত্রীকে পিকআপ করার আগেই `driver:start-trip` কল করতে পারত এবং সাথে সাথে যাত্রীকে `"Trip Started! Your ride has started. Enjoy the trip!"` পুশ নোটিফিকেশন পাঠিয়ে দেওয়া হতো।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- `driverStartTrip.handler.ts` এবং `pickUpRideClean.handler.ts`-এ যাত্রীর পিকআপ OTP ভেরিফিকেশন (`isStartOtpVerified === true`) বাধ্যতামূলক করা হয়েছে। ফলে ড্রাইভার যাত্রীকে পিকআপ করে OTP ভেরিফাই করার আগে ট্রিপ স্টার্ট বা `"Trip Started!"` নোটিফিকেশন ফায়ার হবে না।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/socket/handlers/ride/driverStartTrip.handler.ts`
- `server/src/app/socket/handlers/ride/pickUpRideClean.handler.ts`
- `server/src/app/utils/rideStartOtp.utils.ts`

---

### k. SPLIT-070 | Split ride disappears from matching after first driver accepts

#### কী বাগ ছিল (What Was the Bug):
1. যাত্রী পেমেন্ট করার সময় (`payment.service.ts`) একবার এবং ড্রাইভার রাইড অ্যাক্সেপ্ট করার সময় (`driverAcceptRide.handler.ts` লাইন ৬২০) দ্বিতীয়বার `bookedSeats` ইনক্রিমেন্ট হচ্ছিল (Double Increment)। ফলে ড্রাইভার অ্যাক্সেপ্ট করার পর সিট সংখ্যা ভুল হয়ে রাইডটি ফিল্টার আউট হয়ে যাচ্ছিল।
2. ১ ঘণ্টা পরের স্প্লিট রাইড বুক করার পর প্রথম ড্রাইভার অ্যাক্সেপ্ট করতে করতে ১–২ মিনিট পার হয়ে গেলে (যখন পিকআপের আর ৫৮–৫৯ মিনিট বাকি), ২য় যাত্রী সার্চ (`ride:find-nearby-split-ride`) বা জয়েন (`ride:join-split-ride`) করার সময় `assertMinimumBookingLeadTime` (১ ঘণ্টা লিড-টাইম চেক) এরর থ্রো করত, যার ফলে বিদ্যমান রাইড থাকা সত্ত্বেও ২য় যাত্রীকে `"No split ride available"` দেখাত।
3. সার্চ রেসপন্সে রাইডের `confirmed` যাত্রীদের তালিকা (`passengers`) যুক্ত ছিল না।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- `driverAcceptRide.handler.ts` এবং `splitFare.utils.ts`-এ `bookedSeats` ডাবল ইনক্রিমেন্ট বন্ধ করে সক্রিয় যাত্রীদের প্রকৃত `requestedSeats`-এর যোগফল (`exactBookedSeats`) সেট করা হয়েছে।
- `findNearBySplitRide.handler.ts` এবং `splitRideRequest.handler.ts`-এ বিদ্যমান স্প্লিট রাইড সার্চ বা জয়েন করার সময় ১ ঘণ্টার লিড-টাইম বাধার কারণে যেন ভবিষ্যৎ রাইড ব্লক না হয় (কেবল নতুন রাইড তৈরির সময় লিড-টাইম চেক হয়) তা নিশ্চিত করা হয়েছে।
- `findNearBySplitRide.handler.ts`-এর রেসপন্সে `pending`, `confirmed` ও `driver_arrived` স্ট্যাটাসের যাত্রীদের তালিকা (`passengers`) যুক্ত করা হয়েছে।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/socket/handlers/ride/findNearBySplitRide.handler.ts`
- `server/src/app/socket/handlers/ride/splitRideRequest.handler.ts`
- `server/src/app/socket/handlers/ride/driverAcceptRide.handler.ts`
- `server/src/app/utils/splitFare.utils.ts`

