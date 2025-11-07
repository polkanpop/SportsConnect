
// courtBookings.ts
export const courtBookings = [
  {
    courtbookingid: 1,
    availabilityid: "courtA",
    userid: 1,
    status: "Completed",
    paymentid: 101,
    start_timestamp: "2025-11-01T09:00:00",
    end_timestamp: "2025-11-01T10:00:00",
    sport: "Basketball",
    court: "Court A",
    type: "stadiumCal",
    day: "Mon"
  },
  {
    courtbookingid: 2,
    availabilityid: "courtB",
    userid: 2,
    status: "Upcoming",
    paymentid: 102,
    start_timestamp: "2025-11-02T11:00:00",
    end_timestamp: "2025-11-02T12:00:00",
    sport: "Badminton",
    court: "Court B",
    type: "stadiumCal",
    day:""
  },
  {
    courtbookingid: 3,
    availabilityid: "courtC",
    userid: 3,
    status: "Completed",
    paymentid: 103,
    start_timestamp: "2025-11-03T13:00:00",
    end_timestamp: "2025-11-03T14:00:00",
    sport: "Tennis",
    court: "Court C",
    type: "stadiumCal",
    day:"Fri"
  },
  {
    courtbookingid: 4,
    availabilityid: "courtD",
    userid: 4,
    status: "Cancelled",
    paymentid: 104,
    start_timestamp: "2025-11-04T15:00:00",
    end_timestamp: "2025-11-04T16:00:00",
    sport: "Table Tennis",
    court: "Court D",
    type: "stadiumCal",
    day:""
  },
  {
    courtbookingid: 5,
    availabilityid: "courtE",
    userid: 5,
    status: "Upcoming",
    paymentid: 105,
    start_timestamp: "2025-11-05T17:00:00",
    end_timestamp: "2025-11-05T18:00:00",
    sport: "Basketball",
    court: "Court E",
    type: "stadiumCal",
    day:""
  },
  {
    courtbookingid: 6,
    availabilityid: "courtF",
    userid: 6,
    status: "Completed",
    paymentid: 106,
    start_timestamp: "2025-11-06T19:00:00",
    end_timestamp: "2025-11-06T20:00:00",
    sport: "Football",
    court: "Court F",
    type: "stadiumCal",
    day:"Thu"
  },
  {
    courtbookingid: 7,
    availabilityid: "courtG",
    userid: 7,
    status: "Upcoming",
    paymentid: 107,
    start_timestamp: "2025-11-07T21:00:00",
    end_timestamp: "2025-11-07T22:00:00",
    sport: "Pickleball",
    court: "Court G",
    type: "stadiumCal",
    day:"Sat"
  },
];

// eventBookings.ts
export const eventBookings = [
  {
    eventbookingid: 1,
    eventid: 1,
    userid: 1,
    paymentid: 101,
    status: "Completed",
    event: "Event A",
    date: "2025-11-01",
    time: "09:00",
    message: "Annual Sports Event",
    type: "starCal",
    day:""
  },
  {
    eventbookingid: 2,
    eventid: 2,
    userid: 2,
    paymentid: 102,
    status: "Upcoming",
    event: "Event B",
    date: "2025-11-02",
    time: "11:00",
    message: "Health & Wellness Fair",
    type: "starCal",
    day:""
  },
  {
    eventbookingid: 3,
    eventid: 3,
    userid: 3,
    paymentid: 103,
    status: "Cancelled",
    event: "Event C",
    date: "2025-11-03",
    time: "13:00",
    message: "Charity Auction",
    type: "starCal",
    day:"Tue"
  },
  {
    eventbookingid: 4,
    eventid: 4,
    userid: 4,
    paymentid: 104,
    status: "Completed",
    event: "Event D",
    date: "2025-11-04",
    time: "15:00",
    message: "Music Festival",
    type: "starCal",
    day:"Thur"
  },
  {
    eventbookingid: 5,
    eventid: 5,
    userid: 5,
    paymentid: 105,
    status: "Upcoming",
    event: "Event E",
    date: "2025-11-05",
    time: "17:00",
    message: "Tech Conference 2025",
    type: "starCal",
    day:"Sun"
  },
  {
    eventbookingid: 6,
    eventid: 6,
    userid: 6,
    paymentid: 106,
    status: "Completed",
    event: "Event F",
    date: "2025-11-06",
    time: "19:00",
    message: "Food & Drink Expo",
    type: "starCal",
    day:"Wed"
  },
  {
    eventbookingid: 7,
    eventid: 7,
    userid: 7,
    paymentid: 107,
    status: "Upcoming",
    event: "Event G",
    date: "2025-11-07",
    time: "21:00",
    message: "Gaming Tournament",
    type: "starCal",
    day:"Thu"
  },
];

// trainingSessions.ts
export const trainingSessions = [
  {
    sessionid: 1,
    sessioninfo: "Beginner Basketball Training",
    courtbookingid: 1,
    time: "2025-11-01T09:00:00",
    status: "Completed",
    coachid: 1,
    type: "coachCal",
    day:"Fri"
  },
  {
    sessionid: 2,
    sessioninfo: "Advanced Badminton Training",
    courtbookingid: 2,
    time: "2025-11-02T11:00:00",
    status: "Upcoming",
    coachid: 2,
    type: "coachCal",
    day:""
  },
  {
    sessionid: 3,
    sessioninfo: "Tennis for All",
    courtbookingid: 3,
    time: "2025-11-03T13:00:00",
    status: "Completed",
    coachid: 3,
    type: "coachCal",
    day:""
  },
  {
    sessionid: 4,
    sessioninfo: "Table Tennis Masterclass",
    courtbookingid: 4,
    time: "2025-11-04T15:00:00",
    status: "Cancelled",
    coachid: 4,
    type: "coachCal",
    day:"Wed"
  },
  {
    sessionid: 5,
    sessioninfo: "Running Endurance Training",
    courtbookingid: 5,
    time: "2025-11-05T17:00:00",
    status: "Upcoming",
    coachid: 5,
    type: "coachCal",
    day:""
  },
  {
    sessionid: 6,
    sessioninfo: "Football Skill Development",
    courtbookingid: 6,
    time: "2025-11-06T19:00:00",
    status: "Completed",
    coachid: 6,
    type: "coachCal",
    day:""
  },
  {
    sessionid: 7,
    sessioninfo: "Pickleball Advanced Training",
    courtbookingid: 7,
    time: "2025-11-07T21:00:00",
    status: "Upcoming",
    coachid: 7,
    type: "coachCal",
    day:"Mon"
  },
];
