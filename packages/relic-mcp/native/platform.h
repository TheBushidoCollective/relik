#ifndef RELIC_SECURE_OPEN_PLATFORM_H
#define RELIC_SECURE_OPEN_PLATFORM_H

#ifdef __cplusplus
extern "C" {
#endif

enum relic_open_reason {
  RELIC_OPEN_REASON_NONE = 0,
  RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE = 1,
};

struct relic_open_error {
  int errno_value;
  const char *syscall_name;
  enum relic_open_reason reason;
};

int relic_probe_confined_open(struct relic_open_error *error);
int relic_open_root(const char *path, struct relic_open_error *error);
int relic_open_descendant(
  int root_fd,
  const char *relative_path,
  struct relic_open_error *error
);

#ifdef __cplusplus
}
#endif

#endif
