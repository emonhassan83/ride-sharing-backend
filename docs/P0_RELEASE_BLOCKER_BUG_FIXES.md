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
| **e** | **SPLIT-058** | রিয়েল-টাইম রিকোয়েস্ট না আসা, অ্যাপ ওপেন করলে অফলাইন হয়ে যাওয়া এবং অফলাইনেও রাইড অ্যাক্সেপ্ট হওয়া | `server/src/app/socket/socket.init.ts`<br>`server/src/app/socket/handlers/disconnect.handler.ts`<br>`server/src/app/socket/handlers/ride/driverGoOnline.handler.ts`<br>`server/src/app/socket/handlers/ride/driverLocationUpdate.handler.ts`<br>`server/src/app/socket/handlers/ride/driverAcceptRide.handler.ts`<br>`server/src/app/modules/ride/ride.service.ts`<br>`server/src/app/socket/handlers/ride/getRidePassengers.handler.ts`<br>`server/src/app/utils/notifyDrivers.utils.ts` |
| **f** | **SPLIT-061** | প্রাইভেট রাইড ডিসপ্যাচ কাজ না করা (কাছাকাছি অনলাইন ড্রাইভার রিকোয়েস্ট না পাওয়া) | `server/src/app/utils/notifyDrivers.utils.ts`<br>`server/src/app/utils/geo.utils.ts`<br>`server/src/app/modules/payment/payment.service.ts` |
| **g** | **SPLIT-062** | ডিলিট করা ড্রাইভার অ্যাকাউন্ট পুনরায় খুললে পুরনো ডাটা ও KYC ফিরে আসা | `server/src/app/modules/user/user.service.ts`<br>`server/src/app/modules/auth/auth.service.ts` |
| **g.1** | **SPLIT-018** | অ্যাকাউন্ট ডিলিট করার পর পুনরায় Signup-এ Role Validation Error ("Role is required") ও রোল সিলেক্ট করতে না দেওয়া | `server/src/app/modules/user/user.validation.ts`<br>`server/src/app/modules/user/user.controller.ts`<br>`server/src/app/modules/user/user.service.ts`<br>`server/src/app/modules/auth/auth.validations.ts`<br>`server/src/app/modules/auth/auth.controller.ts`<br>`server/src/app/modules/auth/auth.routes.ts`<br>`server/src/app/modules/auth/auth.service.ts`<br>`server/src/app/middlewares/auth.ts` |
| **h** | **SPLIT-063** | অ্যাপ রিস্টার্ট না দেওয়া পর্যন্ত ড্রাইভারের কাছে রিয়েল-টাইমে রাইড রিকোয়েস্ট না আসা | `server/src/app/socket/socket.init.ts`<br>`server/src/app/socket/handlers/disconnect.handler.ts`<br>`server/src/app/utils/notifyDrivers.utils.ts` |
| **i** | **SPLIT-064** | স্প্লিট রাইড ম্যাচ পাওয়ার পর অটো-রিফান্ড হয়ে যাওয়া এবং পরে আবার রাইড কমপ্লিট ও পেইড দেখানো | `server/src/app/socket/handlers/ride/driverAcceptRide.handler.ts`<br>`server/src/app/job/noDriverFound.job.ts`<br>`server/src/app/utils/splitFare.utils.ts`<br>`server/src/app/socket/handlers/ride/pickUpRideClean.handler.ts`<br>`server/src/app/socket/handlers/ride/driverDropOffPassenger.handler.ts`<br>`server/src/app/socket/handlers/ride/driverCompleteTrip.handler.ts`<br>`server/src/app/modules/meta/meta.service.ts` |
| **j** | **SPLIT-065** | যাত্রীকে পিকআপ করার আগেই "Your ride has started" নোটিফিকেশন চলে যাওয়া | `server/src/app/socket/handlers/ride/driverStartTrip.handler.ts`<br>`server/src/app/socket/handlers/ride/pickUpRideClean.handler.ts`<br>`server/src/app/utils/rideStartOtp.utils.ts` |
| **k** | **SPLIT-070** | প্রথম ড্রাইভার রাইড অ্যাক্সেপ্ট করার পর সেই স্প্লিট রাইডটি অন্য যাত্রীদের সার্চে আর না পাওয়া যাওয়া | `server/src/app/socket/handlers/ride/findNearBySplitRide.handler.ts`<br>`server/src/app/socket/handlers/ride/splitRideRequest.handler.ts`<br>`server/src/app/socket/handlers/ride/driverAcceptRide.handler.ts`<br>`server/src/app/utils/splitFare.utils.ts`<br>`server/src/app/modules/payment/payment.service.ts`<br>`server/src/app/job/splitRidePendingMatch.job.ts` |

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

### c. SPLIT-045 | Offline driver receives ride invitation (Client Clarification & Rule)

#### ক্লায়েন্ট রিকোয়ারমেন্ট / কনটেক্সট (Client Requirement & Clarification):
- ক্লায়েন্টের নির্দেশনা অনুযায়ী, অফলাইন ড্রাইভাররাও রাইড ইনভাইটেশন (FCM Push Notification এবং In-App Notification) পাবে। তবে এর জন্য শর্ত হচ্ছে: **Location ও Geo-radius** ম্যাচ করতে হবে (প্রাইভেট রাইডের ক্ষেত্রে পিকআপ থেকে ১০ কিমি ব্যাসার্ধ এবং স্প্লিট রাইডের ক্ষেত্রে ১৫ কিমি রুট করিডোর)।
- ড্রাইভার সক্রিয় (`status: 'active'`), KYC ভেরিফাইড (`isKycVerified: true`), অবলুপ্ত নয় (`!isDeleted`), গাড়ি উপযুক্ত এবং শিডিউল কনফ্লিক্ট মুক্ত হতে হবে।

#### কীভাবে বাস্তবায়ন করা হয়েছে (How It Is Implemented):
1. **`notifyNearbyDrivers` ও `notifyNearbyDriversForSplitRide`**:
   - অনলাইন ড্রাইভারদের সাথে সাথে MongoDB-এর `$nearSphere` জিও-কুয়েরির মাধ্যমে নির্দিষ্ট রেডিয়াসের (১০ কিমি / ১৫ কিমি) মধ্যে থাকা যোগ্য অফলাইন ড্রাইভারদেরও খুঁজে বের করা হয়।
2. **`emitNewRideRequestToDriver`**:
   - অনলাইন ড্রাইভারদের ক্ষেত্রে রিয়েল-টাইম সকেট ইভেন্ট (`ride:new-request`) পাঠানো হয়।
   - অনলাইন এবং অফলাইন—উভয় ড্রাইভারদের ফোনে লোকালাইজড **FCM Push Notification** পাঠানো হয় এবং ডাটাবেজে **In-App Notification** সেভ করা হয়।
3. **`driverAcceptRideHandler`**:
   - কোনো অফলাইন ড্রাইভার পুশ নোটিফিকেশন পেয়ে রাইড এক্সেপ্ট করলে তাকে আটকে না দিয়ে স্বয়ংক্রিয়ভাবে তার স্ট্যাটাস `isOnline: true` এবং Redis-এর `users:online`-এ যুক্ত করে রাইড বরাদ্দ নিশ্চিত করা হয়।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/utils/notifyDrivers.utils.ts`
- `server/src/app/socket/handlers/ride/driverAcceptRide.handler.ts`
- `server/src/app/utils/geo.utils.ts`

---

### d. SPLIT-051 | Ride can start without passenger authorization (Pickup OTP Flow)

#### কী বাগ ছিল (What Was the Bug):
- ড্রাইভার যাত্রীর কাছ থেকে কোনো OTP ভেরিফাই করা ছাড়াই পিকআপ সম্পন্ন (`driver:pickup-ride`) করতে পারত, অথবা ট্রিপ স্টার্ট করার সময় (`driver:start-trip`) অপ্রয়োজনীয়ভাবে অটোমেটিক OTP চলে যেত।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- `Passenger` মডেলে `isStartOtpVerified: { type: Boolean, default: false }` ফিল্ড যুক্ত করা হয়েছে।
- **ট্রিপ স্টার্ট (`driver:start-trip`) বনাম পিকআপ (`driver:pickup-ride`) OTP নিয়ম:**
  - **ট্রিপ স্টার্ট করার সময় (`driver:start-trip`) কোনো অটোমেটিক OTP যাবে না বা ব্লক করবে না:** ড্রাইভার যখন পিকআপ লোকেশনের উদ্দেশ্যে যাত্রা শুরু করে (`driver:start-trip`), তখন রাইডের স্ট্যাটাস `started` হবে কিন্তু তখন অটোমেটিক কোনো OTP পাঠানো হবে না। একইভাবে পিকআপ লোকেশনে পৌঁছানোর (`driver:arrived-pickup` / `triggerArrival`) সময়ও অটোমেটিক OTP যাবে না।
  - **যাত্রীকে পিকআপ করার সময় (`driver:pickup-ride`) অটোমেটিক OTP যাবে এবং ভেরিফিকেশন বাধ্যতামূলক:** ড্রাইভার যখন যাত্রীকে পিকআপ করতে যাবে (`driver:pickup-ride`) এবং যাত্রীর OTP এখনও ভেরিফাইড না থাকে (`isStartOtpVerified === false`), তখন স্বয়ংক্রিয়ভাবে সেই যাত্রীর কাছে ৬-ডিজিট OTP চলে যাবে এবং `requiresOtp: true` রিটার্ন করবে। এছাড়া অ্যাপ থেকে সরাসরি `POST /api/v1/ride/send-start-otp` বা সকেট `driver:send-start-otp` কল করেও পিকআপের সময় OTP পাঠানো যাবে।
- পিকআপের জন্য **বাধ্যতামূলক ৬-ডিজিট (6-Digit) OTP** জেনারেশন ও ভেরিফিকেশন সিস্টেম:
  1. **`POST /api/v1/ride/send-start-otp`** (এবং সকেট ইভেন্ট `driver:send-start-otp` / `driver:pickup-ride` অটো-ট্রিগার):
     - রিকোয়েস্ট বডি (বাধ্যতামূলক): `{ "rideId": "<rideId>", "passengerId": "<passengerId>" }`
     - কাজ: ৬-ডিজিটের ক্রিপ্টোগ্রাফিক OTP জেনারেট করে Redis-এ ১০ মিনিটের মেয়াদে সেভ করে এবং:
       - **Phone SMS (Twilio)**: `otp.service.ts`-এর নিয়মে যাত্রীর ভেরিফাইড ফোন নম্বরে সরাসরি Twilio SMS পাঠানো হয় (ডেভেলপমেন্ট মোডে কনসোলে লগ ও API রেসপন্সে `otp` রিটার্ন করা হয়)।
       - **Push Notification**: যাত্রীর ফোনে তাৎক্ষণিক পুশ নোটিফিকেশন পাঠানো হয়।
       - **Email Notification**: ব্যাকগ্রাউন্ড ইমেইল কিউয়ের মাধ্যমে যাত্রীর ইমেইলে OTP পৌঁছে যায়।
       - **Real-time Socket**: প্যাসেঞ্জারের সকেট রুমে (`user:${userId}`, `passenger:${passengerId}`) `ride:start-otp` ইভেন্ট পাঠিয়ে দেওয়া হয়।
  2. **`POST /api/v1/ride/verify-start-otp`** (এবং সকেট ইভেন্ট `driver:verify-start-otp` অথবা `driver:pickup-ride` এ `{ otp }` পাস করা):
     - রিকোয়েস্ট বডি (বাধ্যতামূলক): `{ "rideId": "<rideId>", "passengerId": "<passengerId>", "otp": "123456" }`
     - কাজ: ৬-ডিজিট OTP সঠিক হলে `passenger.isStartOtpVerified = true` করা হয়।
     - **উভয় প্রান্তে (Both Sides) রিয়েল-টাইম ইভেন্ট ব্রডকাস্ট**: ভেরিফিকেশন সম্পন্ন হওয়ার সাথে সাথে ড্রাইভার (`driver:${driverId}`) এবং প্যাসেঞ্জার (`user:${passenger.userId}`) উভয় সাইডেই সকেটে `ride:start-otp-verified` এবং `driver:verify-start-otp` ইভেন্ট পাঠানো হয় যাতে উভয় অ্যাপ স্ক্রিন স্বয়ংক্রিয়ভাবে আপডেট হয়ে যায়।
  3. **স্প্লিট রাইড বনাম প্রাইভেট রাইডের পিকআপ ও রাইড শুরুর নিয়ম:**
     - **প্রাইভেট রাইড:** ড্রাইভার রাইড স্টার্ট (`driver:start-trip`) করলে কোনো অটো OTP ছাড়াই ট্রিপ স্টার্ট হয়। এরপর পিকআপের সময় (`driver:pickup-ride`) যাত্রীর কাছে ৬-ডিজিট OTP যায় এবং ভেরিফাই করলেই যাত্রী `picked_up` হয়।
     - **স্প্লিট রাইড (Multi-Passenger Split Pickup):**
       - স্প্লিট রাইডে প্রতিটি যাত্রীর পিকআপ স্পট আলাদা হতে পারে। ড্রাইভার ১ম যাত্রীর পিকআপ করার সময় (`driver:pickup-ride`) তার স্বতন্ত্র ৬-ডিজিট OTP ভেরিফাই করে পিকআপ (`picked_up`) সম্পন্ন করে।
       - ২য় (বা পরবর্তী) কোনো যাত্রী ততক্ষণ পর্যন্ত `picked_up` হবে না যতক্ষণ না ড্রাইভার তার নিজস্ব পিকআপের সময় তার স্বতন্ত্র ৬-ডিজিট OTP ভেরিফাই করছে। প্রতিটি যাত্রীর নিজস্ব পিকআপ OTP ভেরিফিকেশন সম্পূর্ণ পৃথকভাবে সংরক্ষিত থাকে।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/utils/rideStartOtp.utils.ts`
- `server/src/app/modules/passenger/passenger.interface.ts`
- `server/src/app/modules/passenger/passenger.model.ts`
- `server/src/app/modules/ride/ride.routes.ts`
- `server/src/app/modules/ride/ride.controller.ts`
- `server/src/app/modules/ride/ride.validation.ts`
- `server/src/app/modules/ride/ride.service.ts`
- `server/src/app/socket/socket.event.ts`
- `server/src/app/socket/handlers/ride/driverStartTrip.handler.ts`
- `server/src/app/socket/handlers/ride/driverArrivedClean.handler.ts`
- `server/src/app/socket/handlers/ride/pickUpRideClean.handler.ts`
- `server/src/app/socket/handlers/ride/pickUpRide.handler.ts`
- `server/src/app/socket/utils/triggerArrival.ts`

---

### e. SPLIT-058 এবং h. SPLIT-063 | Missing real-time requests, unexpected offline switch, and requests only arriving after app restart

#### কী বাগ ছিল (What Was the Bug):
1. `socket.init.ts` এবং `disconnect.handler.ts`—উভয় জায়গায় `disconnect` ইভেন্ট রেজিস্টার করা ছিল এবং ড্রাইভার অ্যাপ সামান্য সময়ের জন্য ব্যাকগ্রাউন্ডে গেলে বা রিকানেক্ট হলে সাথে সাথে ডাটাবেজে `isOnline: false` করে দেওয়া হতো ও Redis থেকে `users:online` ও `drivers:location` মুছে ফেলা হতো।
2. সকেট রিকানেক্ট হলে ড্রাইভার `driver:${userId}` রুমে জয়েন করলেও Redis-এর `users:online` সেটে যুক্ত হতো না। ফলে `emitNewRideRequestToDriver`-এ `redis.sismember('users:online', driverId)` মিথ্যা (`0`) হওয়ায় সকেটে `ride:new-request` ইভেন্ট যেত না; অ্যাপ রিস্টার্ট দিলে কেবল REST API থেকে রিকোয়েস্ট লোড হতো।
3. `driverGoOnline.handler.ts`-এ Redis হ্যাশে `driverId` সেট না করায় প্রতিবার সকেট রিকানেক্টে `socket.init.ts` ভাবত ডাটা মিসিং এবং শুধুমাত্র `totalSeats` ওভাররাইট করত (`seats` মিসিং থাকায় ৬-সিটার গাড়ি ৪-সিটারে ড্রপ করত)।
4. `driverLocationUpdate.handler.ts`-এ নিয়মিত লোকেশন পিং করার সময় ড্রাইভারের সকেট রুম ও `users:online` রিফ্রেশ হতো না।
5. ড্রাইভার স্প্লিট রাইডে ১ম যাত্রীকে অ্যাক্সেপ্ট করার পর রাইডের স্ট্যাটাস `accepted` হয়ে যেত। পরবর্তীতে ২য় যাত্রী সেই রাইডে জয়েন করলে (`passenger.status: 'pending'`), ড্রাইভার অ্যাপ পুনরায় ওপেন করে `GET /api/v1/ride/driver-rides?status=pending` কল করলে সেই স্প্লিট রাইডটি আর দেখা যেত না (কারণ কুয়েরি শুধুমাত্র `ride.status: 'pending'` খুঁজত)। এছাড়া `getRidePassengers.handler.ts`-এ `pending` স্ট্যাটাস বাদ থাকায় ড্রাইভার অ্যাক্টিভ রাইডে নতুন যুক্ত হওয়া অপেক্ষমাণ যাত্রীকে দেখতে পেত না।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- `socket.init.ts` থেকে ডুপ্লিকেট `disconnect` লিসেনার সরানো হয়েছে এবং `disconnect.handler.ts`-এ সকেট ডিসকানেক্ট হলেই ড্রাইভারকে অফলাইন (`isOnline: false`) করে দেওয়া বন্ধ করা হয়েছে (ড্রাইভার কেবল `driver:go-offline` বা `logout` করলেই অফলাইন হবে)।
- সকেট কানেক্ট/রিকানেক্ট হওয়ার সময় (`socket.init.ts`) ডাটাবেজে ড্রাইভার `isOnline: true` থাকলে স্বয়ংক্রিয়ভাবে Redis-এর `users:online`, `drivers:location`, এবং `driver:${userId}:details` রিস্টোর করা হয়েছে এবং উভয় স্থানে `driverId`, `seats`, ও `totalSeats` সংগতিপূর্ণভাবে সংরক্ষণ নিশ্চিত করা হয়েছে।
- `driverLocationUpdate.handler.ts`-এ নিয়মিত লোকেশন আপডেটের সাথে সাথে `socket.join('driver:' + driverId)` এবং `redis.sadd('users:online', driverId)` নিশ্চিত করা হয়েছে।
- `ride.service.ts` (`getDriverRides`)-এ `status=pending` কুয়েরির ক্ষেত্রে `accepted` স্প্লিট রাইডে কোনো `pending` যাত্রী থাকলে তা ড্রাইভারের পেন্ডিং লিস্টে প্রদর্শন করা হয়েছে।
- `getRidePassengers.handler.ts`-এ `PASSENGER_STATUS.pending` অন্তর্ভুক্ত করা হয়েছে যাতে ড্রাইভার তার চলমান স্প্লিট রাইডে নতুন পেন্ডিং যাত্রীকে দেখতে ও অ্যাক্সেপ্ট করতে পারে।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/socket/socket.init.ts`
- `server/src/app/socket/handlers/disconnect.handler.ts`
- `server/src/app/socket/handlers/ride/driverGoOnline.handler.ts`
- `server/src/app/socket/handlers/ride/driverLocationUpdate.handler.ts`
- `server/src/app/socket/handlers/ride/driverAcceptRide.handler.ts`
- `server/src/app/modules/ride/ride.service.ts`
- `server/src/app/socket/handlers/ride/getRidePassengers.handler.ts`
- `server/src/app/utils/notifyDrivers.utils.ts`

---

### f. SPLIT-061 | Private ride dispatch not working

#### কী বাগ ছিল (What Was the Bug):
1. `notifyDrivers.utils.ts`-এর `privateMatchingDriverIds` ফাংশনে ৪-সিটার রাইডের জন্য শুধুমাত্র `isDefault: true` এবং `seats: { $gte: 4, $lte: 5 }` শর্ত দেওয়া ছিল। ফলে ৬-সিটার গাড়ি বা ডিফল্ট ফ্ল্যাগ না থাকা গাড়ির ড্রাইভাররা বাদ পড়ে যাচ্ছিল। এছাড়া `isDeleted: false` ফিল্টারের কারণে যেসব গাড়ির ডকুমেন্টে ফিল্ডটি অনুপস্থিত ছিল সেগুলো বাদ পড়ে যাচ্ছিল।
2. `geo.utils.ts`-এর `fetchDriversWithinRadius` ফাংশনে DB কুয়েরিতে `isOnline: true` ফিল্টার ছিল না, ফলে অফলাইন ড্রাইভাররাও রেসপন্সে চলে আসত। আবার Redis `drivers:location`-এ থাকা অনলাইন ড্রাইভারদের DB `$nearSphere`-এ না পাওয়া গেলে তাদের বাদ দেওয়া হচ্ছিল।
3. প্রাইভেট রাইডে ইউজার নির্দিষ্ট ড্রাইভার সিলেক্ট করলে (`targetDriverIds`), যদি সেই ড্রাইভার অফলাইন বা ব্যস্ত থাকে, তবে `notifyNearbyDrivers`-এ লুপ অন্য সব অনলাইন ড্রাইভারকে স্কিপ করত (`if (targetDriverIds?.length && !targetDriverIds.includes(driverId)) continue;`)। ফলে ৫–৭ বার রিকোয়েস্ট পাঠালেও অন্য কোনো ড্রাইভারের কাছে কল যেত না এবং ০ জন নোটিফাইড হতো।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- `privateMatchingDriverIds`-এ ৪-সিটার রাইডের জন্য `{ $gte: 4 }` গ্রহণ করা হয়েছে এবং `isDeleted: { $ne: true }` চেক দেওয়া হয়েছে।
- `geo.utils.ts`-এ শুধুমাত্র অনলাইন (`isOnline: true`) ড্রাইভারদের DB থেকে কুয়েরি করা হয়েছে এবং Redis `drivers:location`-এর অনলাইন ড্রাইভারদেরও সরাসরি তালিকায় যুক্ত করা হয়েছে (প্রয়োজনে DB থেকে লাইভ ডিটেইলস ফেচ করে)। এছাড়া গাড়ির ক্ষেত্রে `isDefault` না থাকলেও যেকোনো সক্রিয় নন-ডিলিটেড গাড়িকে ফলব্যাক হিসেবে গ্রহণ করা হয়েছে।
- `notifyNearbyDrivers`-এ টার্গেট ড্রাইভার ফলব্যাক মেকানিজম যুক্ত করা হয়েছে: নির্দিষ্ট সিলেক্টেড ড্রাইভার যদি অফলাইন বা ব্যস্ততার কারণে নোটিফিকেশন রিসিভ করতে না পারে (`notifiedCount === 0`), সিস্টেম স্বয়ংক্রিয়ভাবে রেডিয়াসের ভেতরের অন্যান্য সকল অনলাইন এলিজিবল ড্রাইভারদের রাইড রিকোয়েস্ট নোটিফাই করে দেবে।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/utils/notifyDrivers.utils.ts`
- `server/src/app/utils/geo.utils.ts`
- `server/src/app/modules/payment/payment.service.ts`

---

### g. SPLIT-062 | Deleted driver account resurrected with old data

#### কী বাগ ছিল (What Was the Bug):
1. অ্যাকাউন্ট ডিলিট (`deleteUserProfile`) করার সময় `AccountDeletion.create`-এ `reason` ফিল্ড বাধ্যতামূলক ছিল। ক্লায়েন্ট বা মোবাইল অ্যাপ বডিতে `reason` না পাঠালে Mongoose ভ্যালিডেশন ফেইল হয়ে সম্পূর্ণ ট্রানজ্যাকশন রোলব্যাক হয়ে যেত, যার ফলে অ্যাকাউন্ট আদৌ ডিলিট হতো না!
2. অ্যাকাউন্ট ডিলিট করলেও `Provider` (KYC রেকর্ড), `Vehicle`, `UserLocation`, `Notification` রেকর্ডগুলো ডিলিট হতো না এবং ইউজারের প্রোফাইল ফিল্ডগুলো (`profileImage`, `documents`, `stripeAccountId`, `customerId`, রেটিং, ইত্যাদি) পুরোপুরি ওয়াইপ হতো না।
3. পরবর্তীতে একই ইমেইল/ফোন দিয়ে আবার সাইনআপ করলে পুরনো ইউজার ডকুমেন্টটিই রি-অ্যাক্টিভেট হয়ে অ্যাডমিন প্যানেলে পুরনো ছবি, KYC ডকুমেন্টস ও গাড়ির তথ্যসহ (Car info, Profile picture) ফিরে আসত।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- **নিরাপদ ডিলিশন ফলব্যাক**: `deleteUserProfile`-এ `reason` না পাঠানো হলেও ফলব্যাক স্ট্রিং (`'User requested account deletion'`) ব্যবহার করে ট্রানজ্যাকশন ফেইল হওয়া সম্পূর্ণ রোধ করা হয়েছে।
- **ডাটাবেজ রিলেশন ওয়াইপ**: স্ট্রিং এবং ObjectId উভয় আইডি ফরম্যাট সাপোর্ট করে (`{ $in: [uid, userObjectId] }`) ইউজারের সাথে সম্পর্কিত সকল রিলেশন ডাটা (`Provider.deleteMany`, `Vehicle.deleteMany`, `UserLocation.deleteMany`, `Notification.deleteMany`) এবং Redis ক্যাশ ও সেট (`drivers:online`, `drivers:geo`, `users:online`, `drivers:location`) মুছে ফেলা হয়েছে।
- **প্রোফাইল ফিল্ড রিসেট**: ইউজার ডকুমেন্টে `profileImage: null`, `address: null`, `type: null`, `isKycVerified: false`, `isProfileComplete: false`, `documents: []`, `customerId: null`, `stripeAccountId: null`, `wallet: 0`, `avgRating: 0`, `totalRating: 0`, `gender: null`, `dateOfBirth: null`, `experience: null`, `language: null`, `status: 'pending'` করে দেওয়া হয়েছে—ডিলিট করার সময় এবং পুনরায় রেজিস্ট্রেশন (`createUser`, `registerWithGoogle`, `registerWithApple`) করার সময় উভয় ক্ষেত্রেই।
- ফলে পুনরায় সাইনআপ করলে অ্যাডমিন প্যানেলে বা ড্রাইভার অ্যাপে পুরনো কোনো গাড়ির তথ্য বা ডকুমেন্টস প্রদর্শিত হবে না এবং ড্রাইভারকে ফ্রেশভাবে KYC ও গাড়ি সাবমিট করতে হবে।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/modules/user/user.service.ts` (`deleteUserProfile`)
- `server/src/app/modules/auth/auth.service.ts` (`purgeDeletedUserRelations`, `createUser`, `registerWithGoogle`, `registerWithApple`)

---

### g.1. SPLIT-018 | Account Delete করার পর পুনরায় Signup-এ Role Validation Error

#### কী বাগ ছিল (What Was the Bug):
1. ইউজার অ্যাপে অ্যাকাউন্ট ডিলিট করার পর অ্যাপ স্বয়ংক্রিয়ভাবে লগআউট হয়ে লগইন স্ক্রিনে নিয়ে যেত। সেখান থেকে ইউজার যখন "Create an account" (Sign Up) লিঙ্কে ক্লিক করে ফর্ম পূরণ করতেন (Full name, Email, Phone), তখন ব্যাকএন্ডে `POST /api/v1/auth/register` কল হতো।
2. সাইনআপ স্ক্রিনে কোনো রোল সিলেক্টর না থাকায় ক্লায়েন্ট রিকোয়েস্ট বডিতে `role` ফিল্ড পাঠাত না। কিন্তু ব্যাকএন্ডের `UserValidation.createUserValidationSchema`-এ `role` ফিল্ডটি বাধ্যতামূলক (`z.enum(...).required`) ছিল এবং `.strict()` এনফোর্স করা ছিল।
3. এর ফলে ব্যাকএন্ড থেকে সাথে সাথে লাল ব্যানারে `"Role is required."` ভ্যালিডেশন এরর ফিরত। যেহেতু ওই স্ক্রিনে রোল সিলেক্ট করার কোনো অপশন ছিল না এবং ব্যাক বাটন কাজ করছিল না, ইউজার স্থায়ীভাবে আটকে যেতেন।
4. এছাড়া পূর্বে অ্যাকাউন্ট ডিলিট করা ইউজার পুনরায় সাইনআপের পর বা অনবোর্ডিংয়ে তার রোল পরিবর্তন বা পুনরায় সিলেক্ট করার কোনো ডেডিকেটেড এন্ডপয়েন্ট ছিল না।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- **অপশনাল ও রেজল্ভড রোল ভ্যালিডেশন (`user.validation.ts`)**: `createUserValidationSchema`-তে `role` কে অপশনাল করা হয়েছে এবং `.strict()` বাদ দিয়ে `.passthrough()` যুক্ত করা হয়েছে। ফলে মোবাইল অ্যাপ সাইনআপের সময় `role` না পাঠালেও ব্যাকএন্ড কোনো ভ্যালিডেশন এরর দেবে না।
- **বুদ্ধিমান রোল সিলেকশন ও ফলব্যাক (`auth.service.ts` - `createUser`)**:
  - ইউজার সাইনআপে নতুন রোল (`payload.role`) পাঠালে সেই রোলকে অগ্রাধিকার দেওয়া হয়েছে (রোল পুনরায় সিলেক্টের সুবিধা)।
  - যদি রিকোয়েস্টে রোল না থাকে, তবে পূর্বে ডিলিট হওয়া ইউজারের আগের সিলেক্টেড রোল (`existingUser.role`) অক্ষুণ্ণ রাখা হয়েছে। আর একদম নতুন ইউজার হলে ডিফল্ট `USER_ROLE.user` হিসেবে সেট করা হয়েছে।
- **ডেডিকেটেড রোল সিলেকশন এন্ডপয়েন্ট (`/api/v1/auth/select-role`)**:
  - `POST /api/v1/auth/select-role` এবং `PUT /api/v1/auth/select-role` এন্ডপয়েন্ট তৈরি করা হয়েছে।
  - ইউজার `role: 'user'` অথবা `role: 'provider'` সিলেক্ট করতে পারবে (এডমিন রোল ব্লক করা হয়েছে)।
  - রোল আপডেটের সাথে সাথে নতুন `accessToken` এবং `refreshToken` জেনারেট করে রেসপন্সে রিটার্ন করা হয়।
- **ইউজার প্রোফাইল রোল আপডেট (`updateUserProfile`)**:
  - `UserValidation.updateUserValidationSchema`-এ `role` ফিল্ড এলাউ করা হয়েছে এবং `auth` মিডলওয়্যার ও `updateUserProfile`-এ ইউজারের ইচ্ছামতো `user` বা `provider` রোল সুইচ করার পারমিশন দেওয়া হয়েছে।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/modules/user/user.validation.ts` (`createUserValidationSchema`, `updateUserValidationSchema`)
- `server/src/app/modules/user/user.controller.ts` (`updateUserProfile`)
- `server/src/app/modules/user/user.service.ts` (`updateUserProfile`, `deleteUserProfile`)
- `server/src/app/modules/auth/auth.validations.ts` (`selectRoleValidationSchema`)
- `server/src/app/modules/auth/auth.controller.ts` (`selectRole`)
- `server/src/app/modules/auth/auth.routes.ts` (`/select-role`)
- `server/src/app/modules/auth/auth.service.ts` (`createUser`, `selectRole`)
- `server/src/app/middlewares/auth.ts` (স্যানিটাইজেশন ফিল্টার আপডেট)

---

### i. SPLIT-064 | Split ride marked found, automatically refunded, then completed/paid

#### কী বাগ ছিল (What Was the Bug):
1. স্প্লিট রাইডে একাধিক যাত্রী থাকলে ড্রাইভার যখন ১ম যাত্রীকে অ্যাক্সেপ্ট করত (`driverAcceptRide.handler.ts`), তখন অন্য যাত্রী `pending` থাকার কারণে `isLastPassenger === false` হতো এবং `ride.status` ভুলবশত `'pending'`-ই থেকে যেত!
2. পিকআপের সময় হলেই `noDriverFound.job.ts` শুধুমাত্র `status: 'pending'` দেখে (`driverId: null` চেক না করেই) ধরে নিত রাইডে কোনো ড্রাইভার পাওয়া যায়নি এবং সাথে সাথে পুরো রাইডের সব বুকিং ক্যানসেল ও রিফান্ড করে দিত!
3. কিন্তু ১ম যাত্রীর স্ট্যাটাস `confirmed` থাকায় ড্রাইভার পরে ট্রিপটি স্টার্ট ও কমপ্লিট করত, যা আবার বুকিংকে `completed` এবং পেমেন্টকে `paid` করে দিত। এছাড়া `recalculateSplitFares`-এ পেমেন্ট `pending` থাকলেও ভুলবশত রিফান্ড রেকর্ড তৈরি হতো।
4. **অ্যাডমিন প্যানেল Recent Transactions ডিসপ্লে সমস্যা (`meta.service.ts`)**: বুকিংয়ের কার্ড অথরাইজেশনের সময় পেমেন্ট রেকর্ড `authorized` অবস্থায় থাকে। `meta.service.ts`-এ কুয়েরি ফিল্টার ছাড়া সব পেমেন্ট ফেচ করায় অ্যাডমিন ফ্রন্টএন্ডের টারনারি চেক (`status === 'paid' ? 'PAID' : 'REFUNDED'`) এর কারণে অপরিশোধিত/অন-হোল্ড পেমেন্টগুলো সাময়িকভাবে `REFUNDED` হিসেবে প্রদর্শিত হতো এবং ট্রিপ কমপ্লিট হওয়ার পর `PAID` হয়ে যেত।
5. `driverAcceptRide.handler.ts`-এ `status: PASSENGER_STATUS.pending` কমেন্টেড-আউট ছিল এবং ক্যানসেল্ড/রিফান্ডেড বুকিং চেক ছিল না, ফলে রিফান্ডেড যাত্রীকে ড্রাইভার পুনরায় অ্যাক্সেপ্ট করতে পারত।
6. `pickUpRideClean.handler.ts` ও `driverDropOffPassenger.handler.ts`-এ `in_progress` ও `picked_up` স্ট্যাটাসের অমিলের কারণে ট্রিপ চলাকালীন যাত্রী ড্রপ-অফে বাধা হতো।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- `driverAcceptRide.handler.ts`-এ স্প্লিট রাইডে ড্রাইভার প্রথম যাত্রীকে অ্যাক্সেপ্ট করার সাথে সাথেই `rideUpdate.status = RIDE_STATUS.accepted` সেট করা হয়েছে এবং `ride:matching:queue` থেকে রাইডটি সরিয়ে ফেলা হয়েছে।
- `noDriverFound.job.ts`-এ নিশ্চিত করা হয়েছে যে কেবল `driverId: null` এবং কোনো `confirmed`/`in_progress` যাত্রী না থাকলেই রাইড `no_driver_found` হিসেবে ক্যানসেল হবে।
- `meta.service.ts`-এ `recentTransactions`-কে শুধুমাত্র চূড়ান্তকৃত পেমেন্ট (`status: { $in: ['paid', 'refunded'] }`) দ্বারা ফিল্টার করা হয়েছে এবং `salesReport`-এ শুধুমাত্র পরিশোধিত পেমেন্ট (`status: 'paid', isPaid: true`) কাউন্ট করা হয়েছে।
- `driverAcceptRide.handler.ts`-এ কঠোরভাবে `status: PASSENGER_STATUS.pending` এবং বুকিং ক্যানসেল্ড বা রিফান্ডেড হলে (`bookingStatus === 'cancelled'`, `paymentStatus === 'refunded' | 'cancelled_authorization'`) রাইড অ্যাক্সেপ্ট সম্পূর্ণ ব্লক করা হয়েছে।
- `pickUpRideClean.handler.ts`-এ ট্রিপ শুরুর সাথে সাথে স্প্লিট ফেয়ার লক ও অথরাইজড পেমেন্ট ক্যাপচার করা হয়েছে; `driverDropOffPassenger.handler.ts`-এ `picked_up` ও `in_progress` উভয় স্ট্যাটাসকে ড্রপ-অফের জন্য অনুমতি দেওয়া হয়েছে; এবং `driverCompleteTrip.handler.ts`-এ চূড়ান্ত আয়ের পূর্বে যেকোনো অবশিষ্টাংশ অথরাইজেশন ক্যাপচার নিশ্চিত করা হয়েছে।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/socket/handlers/ride/driverAcceptRide.handler.ts`
- `server/src/app/job/noDriverFound.job.ts`
- `server/src/app/utils/splitFare.utils.ts`
- `server/src/app/socket/handlers/ride/pickUpRideClean.handler.ts`
- `server/src/app/socket/handlers/ride/driverDropOffPassenger.handler.ts`
- `server/src/app/socket/handlers/ride/driverCompleteTrip.handler.ts`
- `server/src/app/modules/meta/meta.service.ts`

---

### j. SPLIT-065 | Ride-start notification fires before pickup

#### কী বাগ ছিল (What Was the Bug):
- ড্রাইভার পিকআপ লোকেশনে পৌঁছানোর বা যাত্রীকে পিকআপ করার আগেই `driver:start-trip` কল করলে যাত্রীকে `"Trip Started! Your ride has started. Enjoy the trip!"` পুশ নোটিফিকেশন পাঠিয়ে দেওয়া হতো এবং `pickedUpAt` সেট হয়ে যেত।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- `driverStartTrip.handler.ts`-এ `driver:start-trip` কল হলে কেবল ড্রাইভারের ট্রিপ শুরু (`Ride.status = 'started'`, `Passenger.status = 'in_progress'`) হয়—এখানে কোনো অটোমেটিক OTP পাঠানো হয় না এবং `"Trip Started!"` পুশ নোটিফিকেশন বা `pickedUpAt` সেট করা হয় না।
- শুধুমাত্র যখন ড্রাইভার যাত্রীকে পিকআপ (`driver:pickup-ride` in `pickUpRideClean.handler.ts`) করে এবং যাত্রীর ৬-ডিজিট পিকআপ OTP ভেরিফাই (`isStartOtpVerified === true`) সম্পন্ন হয়, তখনই যাত্রী `picked_up` হয় এবং `"Trip Started! Your ride has started. Enjoy the trip!"` পুশ নোটিফিকেশন পাঠানো হয়।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/socket/handlers/ride/driverStartTrip.handler.ts`
- `server/src/app/socket/handlers/ride/pickUpRideClean.handler.ts`
- `server/src/app/utils/rideStartOtp.utils.ts`

---

### k. SPLIT-070 | Split ride disappears from matching after first driver accepts

#### কী বাগ ছিল (What Was the Bug):
1. যাত্রী পেমেন্ট করার সময় (`payment.service.ts`) একবার এবং ড্রাইভার রাইড অ্যাক্সেপ্ট করার সময় (`driverAcceptRide.handler.ts` লাইন ৬২০) দ্বিতীয়বার `bookedSeats` ইনক্রিমেন্ট হচ্ছিল (Double Increment)। ফলে ড্রাইভার অ্যাক্সেপ্ট করার পর সিট সংখ্যা ভুল হয়ে রাইডটি ফিল্টার আউট হয়ে যাচ্ছিল।
2. ১ ঘণ্টা পরের স্প্লিট রাইড বুক করার পর প্রথম ড্রাইভার অ্যাক্সেপ্ট করতে করতে ১–২ মিনিট পার হয়ে গেলে (যখন পিকআপের আর ৫৮–৫৯ মিনিট বাকি), ২য় যাত্রী সার্চ বা জয়েন করার পর যখন পেমেন্ট করতে যেত (`createPaymentIntent`), তখন `assertMinimumBookingLeadTime` (১ ঘণ্টা বা ৩ ঘণ্টা লিড-টাইম চেক) এরর থ্রো করত। ফলে ২য় যাত্রী পেমেন্ট করতে পারত না এবং স্প্লিট রাইড ম্যাচিং বন্ধ হয়ে যেত।
3. `splitRidePendingMatch.job.ts`-এ ব্যাকলগ ম্যাচিংয়ের সময় শুধুমাত্র `paymentStatus: 'authorized'` চেক করা হতো; ফলে যেসব যাত্রী ওয়ালেট দিয়ে সরাসরি পে করত (`'paid'`), তারা পিয়ার ম্যাচিংয়ে বাদ পড়ে যেত।
4. `splitRideRequest.handler.ts` ও `findNearBySplitRide.handler.ts`-এ সিট ফাঁকা থাকার কুয়েরিতে `totalSeats` বা `bookedSeats` অনুপস্থিত বা নাল থাকলে হিসাব ঠিকমতো মিলত না।

#### কী ফিক্স করা হয়েছে (What Was Fixed):
- `driverAcceptRide.handler.ts` এবং `splitFare.utils.ts`-এ `bookedSeats` ডাবল ইনক্রিমেন্ট বন্ধ করে সক্রিয় যাত্রীদের প্রকৃত `requestedSeats`-এর যোগফল (`exactBookedSeats`) সেট করা হয়েছে।
- `payment.service.ts` (`createPaymentIntent`)-এ পূর্বেই তৈরি হওয়া বুকিংয়ের পেমেন্টের ক্ষেত্রে নতুন করে লিড-টাইম বাধা আরোপ বন্ধ করা হয়েছে (শুধুমাত্র পিকআপ টাইম ইতোমধ্যে অতীত হয়ে গেছে কিনা তা যাচাই করা হয়)।
- `splitRidePendingMatch.job.ts`-এ ব্যাকলগ ম্যাচিং কুয়েরিতে `authorized` এবং `paid` উভয় পেমেন্ট স্ট্যাটাস অন্তর্ভুক্ত করা হয়েছে।
- `splitRideRequest.handler.ts` এবং `findNearBySplitRide.handler.ts`-এ `$ifNull` অপারেটর ব্যবহার করে `totalSeats` ও `bookedSeats` নিরাপদে হ্যান্ডেল করা হয়েছে।

#### কোথায় পরিবর্তন হয়েছে (Changed Files):
- `server/src/app/socket/handlers/ride/findNearBySplitRide.handler.ts`
- `server/src/app/socket/handlers/ride/splitRideRequest.handler.ts`
- `server/src/app/socket/handlers/ride/driverAcceptRide.handler.ts`
- `server/src/app/utils/splitFare.utils.ts`
- `server/src/app/modules/payment/payment.service.ts`
- `server/src/app/job/splitRidePendingMatch.job.ts`

