#ifndef REFORMAFLOW_X2_MEMORY_LIMIT_H
#define REFORMAFLOW_X2_MEMORY_LIMIT_H

#include <stdbool.h>
#include <stdint.h>

static inline bool x2_memory_limit_valid(uint64_t memory, long page) {
    if (page <= 0 || memory == 0 || memory > (uint64_t)INT64_MAX) return false;
    const uint64_t page_bytes = (uint64_t)page;
    if (memory >= ((uint64_t)INT64_MAX - (uint64_t)INT64_MAX % page_bytes)) return false;
    return memory % page_bytes == 0;
}

#endif
