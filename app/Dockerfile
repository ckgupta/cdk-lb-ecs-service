FROM --platform=linux/x86-64 public.ecr.aws/nginx/nginx:stable-alpine

COPY ./site-assets/ /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
