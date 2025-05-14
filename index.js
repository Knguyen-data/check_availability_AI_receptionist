// Main application file (index.js)

require('dotenv').config();

const express = require('express');
const { ChatOpenAI } = require('@langchain/openai');
const { DateTime } = require('luxon');
const axios = require('axios');
const bodyParser = require('body-parser');

// Initialize Express app
const app = express();
app.use(bodyParser.json());

// Log environment variables for debugging (excluding sensitive info)
console.log('Environment variables loaded:', {
  OPENAI_KEY_SET: !!process.env.OPENAI_API_KEY,
  CAL_KEY_SET: !!process.env.CAL_API_KEY,
  PORT: process.env.PORT
});

// Initialize OpenAI with LangChain
const model = new ChatOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  temperature: 0, // Set to 0 for more deterministic outputs
  modelName: "gpt-4.1-nano", // Using gpt-4.1-nano as requested
});

// Cal.com API configuration
const calApiKey = process.env.CAL_API_KEY;
const calApiUrl = 'https://api.cal.com/v2';

// Main webhook endpoint - corresponds to the main webhook in n8n
app.post('/webhook/0bb1d791-61d0-4c82-bd04-319dca34a25d', async (req, res) => {
  try {
    console.log('Webhook received:', req.body);

    // Step 1: Format time using AI (mimics the "Time Format" node)
    const formattedBooking = await formatTimeWithAI(req.body);
    
    if (!formattedBooking) {
      return res.status(400).json({
        status: 'error',
        message: 'Could not process booking information'
      });
    }

    // Step 2: Check availability at Cal.com
    const availabilityResult = await checkAvailability(formattedBooking);

    // Step 3: Return response to user
    return res.json(availabilityResult);
  } catch (error) {
    console.error('Error processing webhook:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error: ' + error.message
    });
  }
});

// Step 1: Format time using AI - mimics the "Time Format" node in n8n
async function formatTimeWithAI(bookingData) {
  try {
    // Create the system prompt similar to the n8n node
    const currentDate = new Date().toLocaleString("en-CA", {
      weekday: "long",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Winnipeg"
    });

    const systemPrompt = `You are an appointment scheduling agent for Creative Nails And Spa in Winnipeg (America/Winnipeg timezone).
The current date is:
${currentDate}

---

## Instructions

### Input Handling

- Input may be a single booking object or an array (up to 3 guests).
- Each booking object contains: "bookingtime", "assigned_stylist", and "duration_of_services".

### For Each Booking Object

- Parse "bookingtime" and convert it to ISO 8601 format in America/Winnipeg timezone as "start_time".
- Extract "duration" as an integer (in minutes) from "duration_of_services".
- Copy "assigned_stylist" as provided.
- Calculate "end_time" by adding the duration (in minutes) to "start_time", output in ISO 8601 format with the correct Winnipeg offset.
- **Do not format as UTC**; always use the local Winnipeg offset (e.g., -05:00 or -06:00).

### Output Format

- For a single booking, return:

{
"start_time": "YYYY-MM-DDTHH:mm:00-05:00",
"duration": integer,
"assigned_stylist": "string",
"end_time": "YYYY-MM-DDTHH:mm:00-05:00"
}

- For multiple bookings, return an array of such objects.
- You only return the "output", no need to specify action or response

---

## Few-Shot Examples

**User Input 1 (Single Booking):**

{
"bookingtime": "next Tuesday at 2pm",
"assigned_stylist": "angelina@creativenails.ca",
"duration_of_services": "60 minutes"
}

**Agent Output:**

{
"start_time": "2025-05-13T14:00:00-05:00",
"duration": 60,
"assigned_stylist": "angelina@creativenails.ca",
"end_time": "2025-05-13T15:00:00-05:00"
}

---

**User Input 2 (Multiple Bookings):**

[
{
"bookingtime": "May 17th at 4pm",
"assigned_stylist": "isabelle@creativenails.ca",
"duration_of_services": "75 minutes"
},
{
"bookingtime": "May 17th at 4pm",
"assigned_stylist": "cathie@creativenails.ca",
"duration_of_services": "45 minutes"
}
]

**Agent Output:**

[
{
"start_time": "2025-05-17T16:00:00-05:00",
"duration": 75,
"assigned_stylist": "isabelle@creativenails.ca",
"end_time": "2025-05-17T17:15:00-05:00"
},
{
"start_time": "2025-05-17T16:00:00-05:00",
"duration": 45,
"assigned_stylist": "cathie@creativenails.ca",
"end_time": "2025-05-17T16:45:00-05:00"
}
]`;

    // Create our user prompt
    const userPrompt = `The input is as follow:
${JSON.stringify(bookingData)}`;

    // Call OpenAI to format the booking using ChatOpenAI
    const response = await model.invoke([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]);

    // Extract the content from the AI response
    const completion = response.content;

    // Parse the result
    let parsedOutput;
    try {
      // Handle potential issues with the AI's output formatting
      const outputText = completion.trim();
      
      // Find the first { or [ in the text
      const startIndex = outputText.indexOf('{') !== -1 ? outputText.indexOf('{') : outputText.indexOf('[');
      if (startIndex === -1) {
        throw new Error("Could not find JSON in the AI's response");
      }
      
      // Extract from there to the end
      const jsonString = outputText.substring(startIndex);
      parsedOutput = JSON.parse(jsonString);
    } catch (parseError) {
      console.error('Error parsing AI output:', parseError);
      console.log('Raw AI output:', completion);
      return null;
    }

    return parsedOutput;
  } catch (error) {
    console.error('Error in formatTimeWithAI:', error);
    return null;
  }
}

// Step 2: Check availability at Cal.com - combines several n8n nodes
async function checkAvailability(formattedBooking) {
  try {
    // Handle single booking only for simplicity
    const booking = Array.isArray(formattedBooking) ? formattedBooking[0] : formattedBooking;
    
    // Extract needed information
    const startTime = booking.start_time;
    const endTime = booking.end_time;
    const duration = booking.duration;
    const assignedStylist = booking.assigned_stylist;

    // Convert to UTC for Cal.com API as done in the n8n workflow
    const startTimeUTC = DateTime.fromISO(startTime, { zone: 'America/Winnipeg' }).toUTC().toISO();
    const endTimeUTC = DateTime.fromISO(endTime, { zone: 'America/Winnipeg' }).toUTC().toISO();

    // Check availability with a 1-hour window before and after (as in n8n)
    const oneHourBefore = DateTime.fromISO(startTimeUTC).minus({ hours: 1 }).toISO();
    const oneHourAfter = DateTime.fromISO(endTimeUTC).plus({ hours: 1 }).toISO();

    // Call Cal.com API to check availability (interval ±1 hour)
    const availabilityResponse = await axios.get(`${calApiUrl}/slots`, {
      params: {
        start: oneHourBefore,
        end: oneHourAfter,
        eventTypeId: "2443726", // From the n8n workflow
        timeZone: "America/Winnipeg",
        duration: duration
      },
      headers: {
        Authorization: `Bearer ${calApiKey}`,
        'cal-api-version': '2024-09-04'
      }
    });

    // Debug the API response
    console.log('Cal.com API response structure:', JSON.stringify(availabilityResponse.data, null, 2));
    
    // Extract available slots from the nested date structure
    let availableSlots = [];
    
    if (availabilityResponse.data && availabilityResponse.data.data) {
      // Iterate through each date key in the response
      Object.keys(availabilityResponse.data.data).forEach(dateKey => {
        // Get the array of slots for this date
        const dateSlots = availabilityResponse.data.data[dateKey];
        // Add them to our overall slots array
        if (Array.isArray(dateSlots)) {
          availableSlots = availableSlots.concat(dateSlots);
        }
      });
    }
    
    console.log('Processed availableSlots:', availableSlots);

    if (!availableSlots || availableSlots.length === 0) {
      // No slots available within the 1-hour window, need to check a wider range
      return await checkWiderAvailability(booking);
    }

    // Check if the exact slot is available
    const desiredDateString = DateTime.fromISO(startTime).toISODate();
    
    const slotsForDate = availableSlots.filter(slot => 
      slot && slot.start && DateTime.fromISO(slot.start).toISODate() === desiredDateString
    );

    // Check if the exact slot is available
    const isExactSlotAvailable = slotsForDate.some(slot => {
      // Compare as DateTime objects, ignoring milliseconds
      const slotTime = DateTime.fromISO(slot.start);
      const requestedTime = DateTime.fromISO(startTime);
      
      return slotTime.hour === requestedTime.hour &&
             slotTime.minute === requestedTime.minute &&
             slotTime.day === requestedTime.day &&
             slotTime.month === requestedTime.month &&
             slotTime.year === requestedTime.year;
    });

    if (isExactSlotAvailable) {
      return {
        status: 'available',
        message: `The desired slot on ${formatDateTime(startTime)} with the selected stylist is currently available. You can proceed with booking.`
      };
    } else {
      // Find nearby slots
      const nearbySlots = findNearbySlotsInTimeWindow(slotsForDate, startTime);

      if (nearbySlots.length > 0) {
        return {
          status: 'unavailable',
          message: `The exact slot is not available, but I have nearby slots starting at [${nearbySlots.join(', ')}]. Ask the customer, otherwise run check_availability again?`
        };
      } else {
        // No slots nearby, check wider availability
        return await checkWiderAvailability(booking);
      }
    }
  } catch (error) {
    console.error('Error checking availability:', error);
    return {
      status: 'error',
      message: 'Error checking availability: ' + error.message
    };
  }
}

// Check wider availability (-5 hours, +1 day) when no slots found in initial window
async function checkWiderAvailability(booking) {
  try {
    // Extract needed information
    const startTime = booking.start_time;
    const endTime = booking.end_time;
    const duration = booking.duration;

    // Convert to UTC for Cal.com API with wider range (-5 hours, +1 day)
    const startTimeUTC = DateTime.fromISO(startTime, { zone: 'America/Winnipeg' })
      .minus({ hours: 5 })
      .toUTC().toISO();
    const endTimeUTC = DateTime.fromISO(endTime, { zone: 'America/Winnipeg' })
      .plus({ days: 1 })
      .toUTC().toISO();

    // Get all available slots
    const allSlotsResponse = await axios.get(`${calApiUrl}/slots`, {
      params: {
        start: startTimeUTC,
        end: endTimeUTC,
        eventTypeId: "2443726",
        timeZone: "America/Winnipeg",
        duration: duration
      },
      headers: {
        Authorization: `Bearer ${calApiKey}`,
        'cal-api-version': '2024-09-04'
      }
    });

    // Debug the API response
    console.log('Wider availability API response structure:', JSON.stringify(allSlotsResponse.data, null, 2));
    
    // Process available slots from date structure
    let allAvailableSlots = [];
    if (allSlotsResponse.data && allSlotsResponse.data.data) {
      Object.keys(allSlotsResponse.data.data).forEach(dateKey => {
        const dateSlots = allSlotsResponse.data.data[dateKey];
        if (Array.isArray(dateSlots)) {
          allAvailableSlots = allAvailableSlots.concat(dateSlots);
        }
      });
    }

    // Get busy slots
    const busyTimesResponse = await axios.get('https://api.cal.com/v2/calendars/busy-times', {
      params: {
        loggedInUsersTz: 'America/Winnipeg',
        'calendarsToLoad[0][credentialId]': '985381',
        'calendarsToLoad[0][externalId]': 'kiennguyen@dashbooking.com',
        dateFrom: startTimeUTC,
        dateTo: endTimeUTC
      },
      headers: {
        Authorization: `Bearer ${calApiKey}`
      }
    });
    
    console.log('Busy times API response structure:', JSON.stringify(busyTimesResponse.data, null, 2));
    
    // Get busy slots safely
    let busySlots = [];
    if (busyTimesResponse.data && busyTimesResponse.data.data) {
      busySlots = busyTimesResponse.data.data.map(slot => ({
        start: DateTime.fromISO(slot.start).setZone('America/Winnipeg').toISO(),
        end: DateTime.fromISO(slot.end).setZone('America/Winnipeg').toISO()
      }));
    }

    // Format the desired time slot
    const desiredTimeSlot = {
      start: startTime,
      end: endTime,
      duration: duration
    };

    // Search for available slots
    return searchForProximitySlots(allAvailableSlots, busySlots, desiredTimeSlot);
  } catch (error) {
    console.error('Error checking wider availability:', error);
    return {
      status: 'error',
      message: 'Error checking wider availability: ' + error.message
    };
  }
}

// Search for nearby slots using the improved proximity algorithm
function searchForProximitySlots(availableSlots, busySlots, desiredSlot) {
  try {
    if (!Array.isArray(availableSlots)) {
      console.error('availableSlots is not an array:', availableSlots);
      return {
        status: 'error',
        message: 'Failed to process available slots: Invalid data format'
      };
    }
    
    // Extract desired datetime information
    const desiredStart = desiredSlot.start;
    const desiredDate = desiredStart ? desiredStart.split('T')[0] : '';
    let desiredDateTime;
    try {
      desiredDateTime = desiredStart ? DateTime.fromISO(desiredStart) : null;
    } catch (err) {
      console.error('Error parsing desired date:', err);
      desiredDateTime = null;
    }
    
    // Check if desired slot is available
    const isDesiredSlotAvailable = availableSlots.some(slot => {
      if (!slot || !slot.start) return false;
      
      const slotTime = DateTime.fromISO(slot.start);
      const requestedTime = DateTime.fromISO(desiredStart);
      
      return slotTime.hour === requestedTime.hour && 
             slotTime.minute === requestedTime.minute &&
             slotTime.day === requestedTime.day &&
             slotTime.month === requestedTime.month &&
             slotTime.year === requestedTime.year &&
             !isSlotBusy(slot.start, busySlots);
    });
    
    if (isDesiredSlotAvailable) {
      return {
        status: 'available',
        message: `The desired slot on ${formatDateTime(desiredStart)} with the selected stylist is currently available. You can proceed with booking.`
      };
    }
    
    // Group slots by date
    const slotsByDate = {};
    for (const slot of availableSlots) {
      if (!slot || !slot.start) continue;
      try {
        const slotDate = DateTime.fromISO(slot.start).toISODate();
        if (!slotsByDate[slotDate]) {
          slotsByDate[slotDate] = [];
        }
        if (!isSlotBusy(slot.start, busySlots)) {
          slotsByDate[slotDate].push(slot);
        }
      } catch (err) {
        console.error('Error processing slot date:', err);
      }
    }
    
    // Process today's slots
    let sameDaySlots = [];
    if (desiredDate && slotsByDate[desiredDate]) {
      sameDaySlots = slotsByDate[desiredDate]
        .filter(slot => {
          if (!slot.start) return false;
          
          const slotTime = DateTime.fromISO(slot.start);
          const requestedTime = DateTime.fromISO(desiredStart);
          
          return !(slotTime.hour === requestedTime.hour && 
                  slotTime.minute === requestedTime.minute &&
                  slotTime.day === requestedTime.day &&
                  slotTime.month === requestedTime.month &&
                  slotTime.year === requestedTime.year);
        })
        .map(slot => slot.start);
    }
    
    let sameDaySorted = [];
    if (desiredDateTime && sameDaySlots.length > 0) {
      // Sort by proximity to desired time
      sameDaySorted = [...sameDaySlots].sort((a, b) => {
        try {
          const timeA = DateTime.fromISO(a);
          const timeB = DateTime.fromISO(b);
          return Math.abs(timeA.diff(desiredDateTime).as('minutes')) - 
                Math.abs(timeB.diff(desiredDateTime).as('minutes'));
        } catch (err) {
          return 0;
        }
      }).slice(0, 5);
      
      // Re-sort chronologically
      sameDaySorted.sort((a, b) => {
        try {
          return DateTime.fromISO(a) < DateTime.fromISO(b) ? -1 : 1;
        } catch (err) {
          return 0;
        }
      });
    } else {
      sameDaySorted = sameDaySlots.slice(0, 5);
    }
    
    // Process next day's slots
    let nextDaySlots = [];
    let nextDay = '';
    if (desiredDateTime) {
      nextDay = desiredDateTime.plus({ days: 1 }).toISODate();
      if (slotsByDate[nextDay]) {
        nextDaySlots = slotsByDate[nextDay]
          .map(slot => slot.start)
          .sort((a, b) => {
            try {
              return DateTime.fromISO(a) < DateTime.fromISO(b) ? -1 : 1;
            } catch (err) {
              return 0;
            }
          })
          .slice(0, 5);
      }
    }
    
    // Format slots for display
    const sameDayTimes = sameDaySorted.map(time => formatTime(time));
    const nextDayTimes = nextDaySlots.map(time => formatTime(time));
    
    // Build response message
    let message = "The desired slot is not available.";
    if (sameDayTimes.length > 0) {
      message += ` Available today at [${sameDayTimes.join(', ')}]`;
      if (nextDayTimes.length > 0) {
        message += `, and tomorrow at [${nextDayTimes.join(', ')}].`;
      } else {
        message += ".";
      }
    } else if (nextDayTimes.length > 0) {
      message += ` Available tomorrow at [${nextDayTimes.join(', ')}].`;
    } else {
      message += " Please try another date.";
    }
    
    return {
      status: 'unavailable',
      message: message
    };
  } catch (error) {
    console.error('Error in proximity search:', error);
    return {
      status: 'error',
      message: 'Error finding alternative slots: ' + error.message
    };
  }
}

// Check if a slot is during a busy period
function isSlotBusy(slotStart, busySlots) {
  if (!Array.isArray(busySlots)) {
    return false;
  }
  
  try {
    const slotTime = DateTime.fromISO(slotStart);
    return busySlots.some(busy => {
      if (!busy || !busy.start || !busy.end) {
        return false;
      }
      
      try {
        const busyStart = DateTime.fromISO(busy.start);
        const busyEnd = DateTime.fromISO(busy.end);
        return slotTime >= busyStart && slotTime < busyEnd;
      } catch (err) {
        return false;
      }
    });
  } catch (err) {
    return false;
  }
}

// Helper function to find nearby slots
function findNearbySlotsInTimeWindow(slots, desiredStartTime) {
  try {
    if (!Array.isArray(slots)) {
      return [];
    }
    
    const desiredTime = DateTime.fromISO(desiredStartTime);
    const oneHourMs = 60 * 60 * 1000;
    
    return slots
      .filter(slot => {
        if (!slot || !slot.start) return false;
        try {
          const slotTime = DateTime.fromISO(slot.start);
          return Math.abs(slotTime.diff(desiredTime).as('milliseconds')) <= oneHourMs;
        } catch (err) {
          return false;
        }
      })
      .map(slot => formatTime(slot.start));
  } catch (error) {
    console.error('Error finding nearby slots:', error);
    return [];
  }
}

// Helper function to format date and time
function formatDateTime(isoString) {
  try {
    const date = DateTime.fromISO(isoString).setZone('America/Winnipeg');
    return date.toFormat("MMMM d, yyyy 'at' h:mm a");
  } catch (error) {
    console.error('Error formatting date and time:', error);
    return isoString || 'Invalid date';
  }
}

// Helper function to format time
function formatTime(isoString) {
  try {
    const date = DateTime.fromISO(isoString).setZone('America/Winnipeg');
    return date.toFormat("h:mm a");
  } catch (error) {
    console.error('Error formatting time:', error);
    return isoString || 'Invalid time';
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('Server is running');
});

// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook available at: http://localhost:${PORT}/webhook/0bb1d791-61d0-4c82-bd04-319dca34a25d`);
});
