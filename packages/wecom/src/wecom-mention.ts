export interface ParsedWeComBotMention {
  matched: boolean;
  text: string;
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

/**
 * Find and remove one exact @BOT_NAME mention from any position in text.
 * Text may touch the leading @, but a following word character must be
 * separated by whitespace; punctuation may follow the name directly.
 */
export function parseWeComBotMention(
  content: string,
  botName: string,
): ParsedWeComBotMention {
  const normalizedBotName = botName.trim();
  if (normalizedBotName.length === 0) {
    return { matched: false, text: "" };
  }

  const marker = `@${normalizedBotName}`;
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const index = content.indexOf(marker, searchFrom);
    if (index < 0) break;

    const afterMarker = content[index + marker.length];
    if (!isWordCharacter(afterMarker)) {
      let before = content.slice(0, index);
      let after = content.slice(index + marker.length);
      const beforeHasWhitespace = /\s$/u.test(before);
      const afterHasWhitespace = /^\s/u.test(after);
      if (beforeHasWhitespace && afterHasWhitespace) {
        after = after.slice(1);
      } else if (
        beforeHasWhitespace &&
        !afterHasWhitespace &&
        /^[\p{P}\p{S}]/u.test(after)
      ) {
        before = before.slice(0, -1);
      }
      return {
        matched: true,
        text: `${before}${after}`.trim(),
      };
    }

    searchFrom = index + marker.length;
  }

  return { matched: false, text: "" };
}
