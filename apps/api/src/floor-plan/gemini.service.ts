import { Injectable, Logger } from '@nestjs/common';

interface RoomDimensions {
  width?: number;
  depth?: number;
  units?: string;
}

interface GeminiRoom {
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  estimatedArea?: { sqft?: number; sqm: number };
  dimensions?: RoomDimensions;
  elements?: string[];
}

export interface GeminiFloorPlanResult {
  rooms: GeminiRoom[];
  scale?: string;
  totalArea?: { sqft?: number; sqm?: number };
}

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private readonly apiKey = process.env['GEMINI_API_KEY'];
  private readonly model = 'gemini-2.5-flash';

  async analyzeFloorPlan(
    imageBase64: string,
    mimeType: string,
  ): Promise<GeminiFloorPlanResult> {
    if (!this.apiKey) {
      this.logger.warn('GEMINI_API_KEY not set, skipping analysis');
      return { rooms: [] };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    // Prompt based on architectural-drawing-parser skill (TerminalSkills/LobeHub)
    const prompt = `You are an expert architectural drawing parser. Analyze this floor plan / architectural drawing and extract ALL structured building data.

## EXTRACTION TASK

For this floor plan image, extract every visible room, space, hallway, and area. Follow these rules precisely:

### ROOM DETECTION RULES
1. **Walls**: Thick lines represent walls. Each enclosed space between walls is a room.
2. **Doors**: Arcs or gaps in walls indicate doors — they separate rooms.
3. **Windows**: Small rectangles on walls, often with parallel lines.
4. **Labels**: Read any text annotations on the drawing for room names.
5. **Fixtures**: Use fixtures to identify room types:
   - Kitchen: sink, stove/cooktop, counter, refrigerator outline
   - Bathroom: toilet, shower/tub, sink/vanity
   - Laundry: washer/dryer symbols
   - Bedroom: closet nearby, larger rectangular room
   - Living room: largest open area, often connected to dining
   - Garage: large space with car outline or wide door
6. **Include ALL spaces**: closets, pantries, hallways, balconies, terraces, utility rooms, service areas, porches, gardens.

### BOUNDING BOX COORDINATES
- x, y = TOP-LEFT corner as PERCENTAGE (0-100) of image width/height
- width, height = room size as PERCENTAGE (0-100) of image width/height
- Boxes must TIGHTLY fit each room's wall boundaries
- Rooms must NOT overlap significantly
- Each room should be a PORTION of the total floor plan, not the entire image

### AREA ESTIMATION
- If a scale is visible (e.g., "1:50", "1/4\\" = 1'-0\\""), use it to calculate real dimensions
- Convert all areas to both sqm and sqft (1 sqft = 0.0929 sqm)
- If no scale, estimate based on typical residential proportions
- Include room dimensions (width x depth) when determinable

### ELEMENTS
For each room, list visible elements: "window", "door", "sink", "stove", "toilet", "shower", "closet", "counter", etc.

### OUTPUT FORMAT
Return room names in Portuguese (BR). Include ALL detected rooms.

{
  "rooms": [
    {
      "name": "Sala de Estar",
      "type": "living",
      "x": 5, "y": 10, "width": 25, "height": 30,
      "estimatedArea": {"sqm": 22.3, "sqft": 240},
      "dimensions": {"width": 5.0, "depth": 4.5, "units": "meters"},
      "elements": ["window", "door"]
    }
  ],
  "scale": "1:50",
  "totalArea": {"sqm": 120, "sqft": 1292}
}

Room types: living, kitchen, bedroom, bathroom, laundry, garage, hall, closet, balcony, office, dining, suite, terrace, pantry, service, garden, porch, storage, other`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: imageBase64,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 16384,
            responseMimeType: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(90000),
      });

      if (!response.ok) {
        const error = await response.text();
        this.logger.error(`Gemini API error ${response.status}: ${error}`);
        return { rooms: [] };
      }

      const data = await response.json();
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text || '';
      const finishReason = candidate?.finishReason;

      if (finishReason === 'MAX_TOKENS') {
        this.logger.warn('Gemini response truncated (MAX_TOKENS).');
      }

      // Extract JSON from response
      let jsonStr = '';
      const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonBlock) {
        jsonStr = jsonBlock[1].trim();
      } else {
        const match = text.match(/\{[\s\S]*"rooms"[\s\S]*\}/);
        jsonStr = match ? match[0] : '';
      }

      if (!jsonStr) {
        this.logger.warn('No JSON found in Gemini response');
        this.logger.debug(`Gemini raw: ${text.slice(0, 500)}`);
        return { rooms: [] };
      }

      // Clean common JSON issues
      jsonStr = jsonStr
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[\x00-\x1f]/g, ' ');

      let result: GeminiFloorPlanResult;
      try {
        result = JSON.parse(jsonStr) as GeminiFloorPlanResult;
      } catch {
        this.logger.warn('JSON parse failed, attempting repair...');
        let repaired = jsonStr;
        repaired = repaired.replace(/,\s*[^}\]]*$/, '');
        const ob = (repaired.match(/\{/g) || []).length;
        const cb = (repaired.match(/\}/g) || []).length;
        const oq = (repaired.match(/\[/g) || []).length;
        const cq = (repaired.match(/\]/g) || []).length;
        for (let i = 0; i < oq - cq; i++) repaired += ']';
        for (let i = 0; i < ob - cb; i++) repaired += '}';

        try {
          result = JSON.parse(repaired) as GeminiFloorPlanResult;
          this.logger.log(`JSON repaired, found ${result.rooms?.length || 0} rooms`);
        } catch {
          this.logger.error('JSON repair also failed');
          this.logger.warn(`Problematic JSON: ${jsonStr.slice(0, 500)}`);
          return { rooms: [] };
        }
      }

      // Ensure dual-unit area conversion
      for (const room of result.rooms || []) {
        if (room.estimatedArea) {
          if (room.estimatedArea.sqm && !room.estimatedArea.sqft) {
            room.estimatedArea.sqft = Math.round(room.estimatedArea.sqm / 0.0929 * 10) / 10;
          }
          if (room.estimatedArea.sqft && !room.estimatedArea.sqm) {
            room.estimatedArea.sqm = Math.round(room.estimatedArea.sqft * 0.0929 * 10) / 10;
          }
        }
      }

      this.logger.log(
        `Gemini detected ${result.rooms?.length || 0} rooms` +
        `${result.scale ? ` (scale: ${result.scale})` : ''}` +
        `${result.totalArea?.sqm ? ` (total: ${result.totalArea.sqm}m²)` : ''}`,
      );
      return result;
    } catch (error) {
      this.logger.error(`Gemini analysis failed: ${error}`);
      return { rooms: [] };
    }
  }
}
